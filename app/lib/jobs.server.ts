/* eslint-disable @typescript-eslint/no-explicit-any -- Shopify GraphQL responses are untyped JSON. */
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { syncAllCollections, syncCollection, loadRuleCollections } from "./collections.server";
import { evaluateProduct } from "./evaluate.server";
import { enqueueJob, type JobType } from "./queue.server";
import {
  createMatcher,
  isVendorExcluded,
  productMatchesCollection,
  productSearchQuery,
} from "./rules/engine";
import type { CollectionSnapshot, ProductSnapshot, RuleSet } from "./rules/types";
import { innerOuter, parseSizes } from "./rules/innerOuter";
import { ruleGroups, ruleValueKeys } from "./rules/ruleGroups";
import { cleanCollection } from "./removal.server";
import { getRules } from "./settings.server";
import { queueSorting, sortCollection } from "./sort.server";
import { assertNoUserErrors, chunk, forEachBulkRow, gql, type AdminClient } from "./shopify/api.server";
import {
  COLLECTION_ADD_PRODUCTS,
  COLLECTION_PRODUCT_IDS,
  productRowParser,
  productSearchPageQuery,
  productsBulkQuery,
  toProductSnapshot,
} from "./shopify/queries";

type Payload = Record<string, any>;

/** Up to this many collections are evaluated by search; more share one full export. */
const SEARCH_LIMIT = 50;

/**
 * Admin client for background jobs. Offline access tokens expire after an hour and jobs can
 * run longer, so the session is loaded (and refreshed when close to expiry) for every call.
 */
async function adminFor(shop: string): Promise<AdminClient> {
  await unauthenticated.admin(shop); // Fail fast when the shop has no session.
  return {
    graphql: async (query, options) => {
      const { admin } = await unauthenticated.admin(shop);
      return (admin as unknown as AdminClient).graphql(query, options);
    },
  };
}

async function addProducts(admin: AdminClient, collectionId: string, productIds: string[]) {
  for (const ids of chunk(productIds, 250)) {
    const data = await gql(admin, COLLECTION_ADD_PRODUCTS, { id: collectionId, productIds: ids });
    assertNoUserErrors("collectionAddProductsV2", data.collectionAddProductsV2.userErrors);
  }
}

/**
 * Reads all products once and returns, per collection, the matching products not in it yet.
 * Subcollection products reach parent collections through Shopify itself.
 */
async function planAdditions(admin: AdminClient, shop: string, collectionIds?: Set<string>) {
  const rules = await getRules(shop);
  const collections = await loadRuleCollections(shop);
  const { products, memberships, add } = productRowParser(rules);
  await forEachBulkRow(admin, productsBulkQuery(rules), add);

  const match = createMatcher(collections, rules);
  const additions = new Map<string, string[]>();
  for (const product of products) {
    if (isVendorExcluded(product, rules)) continue;
    const current = memberships.get(product.id);
    for (const collectionId of match(product)) {
      if (current?.has(collectionId)) continue;
      if (collectionIds && !collectionIds.has(collectionId)) continue;
      const list = additions.get(collectionId);
      if (list) list.push(product.id);
      else additions.set(collectionId, [product.id]);
    }
  }
  return {
    additions,
    productCount: products.length,
    collectionCount: collectionIds?.size ?? collections.length,
  };
}

/** Current products of a collection, with vendor so excluded vendors can be skipped. */
async function collectionProducts(admin: AdminClient, id: string): Promise<ProductSnapshot[]> {
  const products: ProductSnapshot[] = [];
  let after: string | null = null;
  do {
    const data: any = await gql(admin, COLLECTION_PRODUCT_IDS, { id, after });
    const connection = data.collection?.products;
    if (!connection) break;
    for (const node of connection.nodes) products.push({ id: node.id, fields: { vendor: node.vendor ?? null } });
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return products;
}

/**
 * Fills collections using Shopify product search: only products that can match the rules are
 * read, so one collection takes seconds instead of a full export. Collections missing from
 * the app's overview are returned for the full export instead.
 */
async function evaluateBySearch(admin: AdminClient, shop: string, rules: RuleSet, ids: Set<string>) {
  const collections = await loadRuleCollections(shop);
  const byId = new Map(collections.map((c) => [c.id, c]));

  let checked = 0;
  const searchMatches = async (collection: CollectionSnapshot) => {
    const matched: string[] = [];
    const query = productSearchQuery(collection, rules);
    let after: string | null = null;
    while (query !== null) {
      const data: any = await gql(admin, productSearchPageQuery(rules), { query, after });
      for (const node of data.products.nodes) {
        checked++;
        const product = toProductSnapshot(node, rules);
        if (productMatchesCollection(product, collection, rules)) matched.push(product.id);
      }
      after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
      if (!after) break;
    }
    return matched;
  };

  const rest = new Set<string>();
  const changed = new Set<string>();
  let added = 0;
  for (const id of ids) {
    const collection = byId.get(id);
    if (!collection) {
      rest.add(id);
      continue;
    }
    const existing = new Set((await collectionProducts(admin, id)).map((p) => p.id));
    const toAdd = (await searchMatches(collection)).filter((p) => !existing.has(p));
    await addProducts(admin, id, toAdd);
    added += toAdd.length;
    if (toAdd.length > 0) changed.add(id);
  }
  await queueSorting(shop, rules, changed);
  return { checked, added, rest };
}

/** Queues additions planned from a full product export. */
async function queueAdditions(shop: string, additions: Map<string, string[]>) {
  const rules = await getRules(shop);
  let products = 0;
  for (const [collectionId, productIds] of additions) {
    for (const ids of chunk(productIds, 250)) {
      await enqueueJob(shop, "add-products", { collectionId, productIds: ids });
      products += ids.length;
    }
  }
  await queueSorting(shop, rules, additions.keys());
  return products;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Rows per export file, so each file stays a manageable size (about 30 MB). */
const EXPORT_ROWS_PER_FILE = 500_000;

const numericId = (gid: string) => gid.split("/").pop()!;

/** Oldest smart collection created after 2026-10-01; rules are removed from this one and newer. */
const REMOVE_RULES_FROM_ID = "724501135628";

/**
 * Admin client on API 2026-07, which can delete a collection's conditions source. The rest of
 * the app stays on the configured version, where a smart collection's rules can't be removed.
 */
async function adminFor202607(shop: string): Promise<AdminClient> {
  return {
    graphql: async (query, options) => {
      const { session } = await unauthenticated.admin(shop);
      return fetch(`https://${session.shop}/admin/api/2026-07/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken ?? "" },
        body: JSON.stringify({ query, variables: options?.variables }),
      });
    },
  };
}

const SMART_COLLECTIONS_PAGE = `#graphql
  query SmartCollections($query: String!, $after: String, $namespace: String!, $key: String!) {
    collections(first: 100, after: $after, query: $query, sortKey: ID, reverse: true) {
      nodes {
        id
        title
        marker: metafield(namespace: $namespace, key: $key) { value }
        ruleSet { appliedDisjunctively rules { column relation condition } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const COLLECTION_SOURCES = `#graphql
  query CollectionSources($id: ID!) {
    collection(id: $id) { sources { __typename id } }
  }`;

const COLLECTION_DELETE_SOURCES = `#graphql
  mutation CollectionDeleteSources($collection: CollectionUpdateInput!) {
    collectionUpdate(collection: $collection) {
      collection { id }
      userErrors { field message }
    }
  }`;

/** Collections whose rules get inner/outer recomputed (collection metafield custom.ucel). */
const INNER_OUTER_MARKER = "YMM_automat";
const INNER_OUTER_TOLERANCE_MM = 2;
/** A run hands the rest to a follow-up job before the 30-minute job timeout. */
const INNER_OUTER_TIME_BUDGET_MS = 20 * 60 * 1000;

const INNER_OUTER_PAGE = `#graphql
  query InnerOuterCollections($after: String) {
    collections(first: 50, after: $after, query: "collection_type:smart", sortKey: ID) {
      nodes {
        id
        title
        productsCount { count }
        marker: metafield(namespace: "custom", key: "ucel") { value }
        original: metafield(namespace: "custom", key: "original_size") { value }
        aftermarket: metafield(namespace: "custom", key: "aftermarket_size") { value }
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
            conditionObject {
              ... on CollectionRuleMetafieldCondition { metafieldDefinition { id namespace key } }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const COLLECTION_UPDATE_RULES = `#graphql
  mutation CollectionUpdateRules($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id }
      userErrors { field message }
    }
  }`;

const COLLECTION_COUNTS = `#graphql
  query CollectionCounts($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Collection { id productsCount { count } } }
  }`;

/** Splits one line of the CSVs written here (quoted cells may hold commas and doubled quotes). */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { cells.push(cell); cell = ""; }
    else cell += c;
  }
  cells.push(cell);
  return cells;
}

const ruleKey = (rule: any) => {
  const d = rule.conditionObject?.metafieldDefinition;
  return d ? `${d.namespace}.${d.key}` : null;
};

const handlers: Record<JobType, (shop: string, payload: Payload, jobId: string) => Promise<string>> = {
  async "sync-collections"(shop) {
    const admin = await adminFor(shop);
    const result = await syncAllCollections(admin, shop, await getRules(shop));
    return `Načteno ${result.synced} kolekcí s pravidly z ${result.total}` +
      (result.smartSkipped ? `, přeskočeno ${result.smartSkipped} smart kolekcí` : "") + ".";
  },

  async "sync-collection"(shop, payload) {
    const admin = await adminFor(shop);
    const { synced } = await syncCollection(admin, shop, await getRules(shop), payload.collectionId);
    return synced ? "Kolekce aktualizována." : "Kolekce nemá pravidla, odebrána z přehledu.";
  },

  async "evaluate-product"(shop, payload) {
    const admin = await adminFor(shop);
    const result = await evaluateProduct(admin, shop, payload.productId);
    if (!result) return "Produkt nenalezen.";
    return `Odpovídá ${result.matched} kolekcím, nově přidán do ${result.added}.`;
  },

  async "evaluate-collection"(shop, payload) {
    const admin = await adminFor(shop);
    const rules = await getRules(shop);
    const { synced } = await syncCollection(admin, shop, rules, payload.collectionId);
    if (!synced) return "Kolekce nemá pravidla (nebo je smart kolekce).";
    // Checking one collection also sorts it, even when nothing new was added.
    await queueSorting(shop, rules, [payload.collectionId]);
    const fast = await evaluateBySearch(admin, shop, rules, new Set([payload.collectionId]));
    if (fast.rest.size === 0) {
      return `Prověřeno ${fast.checked} produktů, přidáno ${fast.added} (včetně nadřazených kolekcí).`;
    }
    const { additions, productCount } = await planAdditions(
      admin,
      shop,
      new Set([payload.collectionId]),
    );
    const toAdd = additions.get(payload.collectionId) ?? [];
    await addProducts(admin, payload.collectionId, toAdd);
    return `Prověřeno ${productCount} produktů, přidáno ${toAdd.length}.`;
  },

  async "evaluate-collections"(shop, payload) {
    const admin = await adminFor(shop);
    const rules = await getRules(shop);
    const ids = new Set<string>();
    for (const id of payload.collectionIds as string[]) {
      const { synced } = await syncCollection(admin, shop, rules, id);
      if (synced) ids.add(id);
    }
    const skipped = (payload.collectionIds as string[]).length - ids.size;
    if (ids.size === 0) return "Žádná kolekce nemá pravidla (nebo jsou to smart kolekce).";
    const skippedText = skipped ? ` (${skipped} přeskočeno, nemají pravidla)` : "";

    // Search per collection pays off for a few collections; many at once share one export.
    if (ids.size <= SEARCH_LIMIT) {
      const fast = await evaluateBySearch(admin, shop, rules, ids);
      let message = `${ids.size - fast.rest.size} kolekcí: prověřeno ${fast.checked} produktů, ` +
        `přidáno ${fast.added}${skippedText}.`;
      if (fast.rest.size > 0) {
        const { additions } = await planAdditions(admin, shop, fast.rest);
        message += ` ${fast.rest.size} kolekcí s podkolekcemi: naplánováno ` +
          `${await queueAdditions(shop, additions)} přiřazení.`;
      }
      return message;
    }
    const { additions, productCount } = await planAdditions(admin, shop, ids);
    return `Prověřeno ${productCount} produktů pro ${ids.size} kolekcí${skippedText}` +
      `. Naplánováno ${await queueAdditions(shop, additions)} přiřazení.`;
  },

  async "evaluate-all"(shop) {
    const admin = await adminFor(shop);
    await syncAllCollections(admin, shop, await getRules(shop));
    const { additions, productCount, collectionCount } = await planAdditions(admin, shop);
    const products = await queueAdditions(shop, additions);
    return `Prověřeno ${productCount} produktů a ${collectionCount} kolekcí. ` +
      `Naplánováno ${products} přiřazení do ${additions.size} kolekcí.`;
  },

  /**
   * Every collection-product pair the rules match directly (active products only unless
   * activeOnly is false; including pairs already in place) as CSV, without changing anything. Current
   * memberships are left out, which keeps the product export small and fast.
   */
  async "export-plan"(shop, payload, jobId) {
    // Products whose title contains any of these texts (case-insensitive) are left out.
    const excludeTitles = ((payload.excludeTitles ?? []) as string[]).map((t) => t.toLowerCase());
    const admin = await adminFor(shop);
    const rules = await getRules(shop);
    await syncAllCollections(admin, shop, rules);
    const collections = await loadRuleCollections(shop);
    const match = createMatcher(collections, rules);
    const additions = new Map<string, string[]>();
    let productCount = 0;
    await forEachBulkRow(admin, productsBulkQuery(rules, { withCollections: false, activeOnly: payload.activeOnly !== false }), (row) => {
      if (typeof row.id !== "string" || !row.id.includes("/Product/")) return;
      productCount++;
      const title = String(row.title ?? "").toLowerCase();
      if (excludeTitles.some((text) => title.includes(text))) return;
      const product = toProductSnapshot(row, rules);
      if (isVendorExcluded(product, rules)) return;
      for (const collectionId of match(product)) {
        const list = additions.get(collectionId);
        if (list) list.push(product.id);
        else additions.set(collectionId, [product.id]);
      }
    });
    const titles = new Map(collections.map((c) => [c.id, c.title]));
    // A retried job starts its files over.
    await db.exportFile.deleteMany({ where: { id: { startsWith: `${jobId}-` } } });
    const header = "collection_id,collection_title,product_id";
    let lines: string[] = [];
    let parts = 0;
    const flush = async () => {
      parts++;
      await db.exportFile.create({ data: { id: `${jobId}-${parts}`, shop, csv: [header, ...lines].join("\n") } });
      lines = [];
    };
    let products = 0;
    for (const [collectionId, productIds] of additions) {
      const collection = `${numericId(collectionId)},${csvCell(titles.get(collectionId) ?? "")},`;
      for (const productId of productIds) {
        lines.push(collection + numericId(productId));
        if (lines.length >= EXPORT_ROWS_PER_FILE) await flush();
      }
      products += productIds.length;
    }
    if (lines.length > 0 || parts === 0) await flush();
    return `Prověřeno ${productCount} produktů. Export: ${additions.size} kolekcí, ${products} přiřazení v ${parts} souborech.`;
  },

  /**
   * For every parent collection, its direct subcollections grouped by the values the rules
   * read, as CSV: one row per parent and distinct combination. Only reads the subcollection
   * metafield, nothing is added.
   */
  async "export-rule-groups"(shop, _payload, jobId) {
    const admin = await adminFor(shop);
    const rules = await getRules(shop);
    await syncAllCollections(admin, shop, rules);
    const rows = ruleGroups(await loadRuleCollections(shop), rules);
    await db.exportFile.deleteMany({ where: { id: { startsWith: `${jobId}-` } } });
    const header = ["parent_id", "parent_title", "subcollections", "distinct_rules", ...ruleValueKeys(rules), "count"].join(",");
    const lines = rows.map((r) =>
      [numericId(r.parentId), csvCell(r.parentTitle), r.childCount, r.groupCount, ...r.values.map(csvCell), r.count].join(","),
    );
    await db.exportFile.create({ data: { id: `${jobId}-1`, shop, csv: [header, ...lines].join("\n") } });
    const parents = new Set(rows.map((r) => r.parentId));
    const children = [...parents].reduce((sum, id) => sum + rows.find((r) => r.parentId === id)!.childCount, 0);
    return `Report: ${parents.size} nadřazených kolekcí, ${children} podkolekcí, ${rows.length} různých kombinací pravidel.`;
  },

  /**
   * One-off: deletes the conditions (rules) of rule-marked smart collections created after
   * 2026-10-01, newest first. The removed rules are saved as a CSV in the job list.
   */
  async "remove-smart-rules"(shop, _payload, jobId) {
    const admin = await adminFor(shop);
    const admin202607 = await adminFor202607(shop);
    const { collectionFilter } = await getRules(shop);
    const lines: string[] = [];
    let removed = 0;
    let skipped = 0;
    let after: string | null = null;
    do {
      const data: any = await gql(admin, SMART_COLLECTIONS_PAGE, {
        query: `collection_type:smart AND id:>=${REMOVE_RULES_FROM_ID}`,
        after,
        namespace: collectionFilter.key.slice(0, collectionFilter.key.indexOf(".")),
        key: collectionFilter.key.slice(collectionFilter.key.indexOf(".") + 1),
      });
      for (const node of data.collections.nodes) {
        if (node.marker?.value !== collectionFilter.value) {
          skipped++;
          continue;
        }
        const sources: any = await gql(admin202607, COLLECTION_SOURCES, { id: node.id });
        const ids = (sources.collection?.sources ?? [])
          .filter((s: any) => s.__typename === "CollectionConditionsSource")
          .map((s: any) => s.id as string);
        if (ids.length === 0) continue;
        const rules = (node.ruleSet?.rules ?? [])
          .map((r: any) => `${r.column} ${r.relation} ${r.condition}`)
          .join("; ");
        const match = node.ruleSet?.appliedDisjunctively ? "ANY" : "ALL";
        console.log(JSON.stringify({ removeSmartRules: { id: node.id, title: node.title, match, rules } }));
        const result: any = await gql(admin202607, COLLECTION_DELETE_SOURCES, {
          collection: { id: node.id, sourcesToDelete: ids },
        });
        assertNoUserErrors("collectionUpdate", result.collectionUpdate.userErrors);
        lines.push([numericId(node.id), csvCell(node.title), match, csvCell(rules)].join(","));
        removed++;
      }
      after = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
    } while (after);
    await db.exportFile.deleteMany({ where: { id: { startsWith: `${jobId}-` } } });
    await db.exportFile.create({
      data: { id: `${jobId}-1`, shop, csv: ["collection_id,collection_title,match,rules", ...lines].join("\n") },
    });
    return `Pravidla smazána u ${removed} kolekcí, přeskočeno ${skipped} bez značky ${collectionFilter.value}. ` +
      "Smazaná pravidla jsou v CSV.";
  },

  /**
   * One-off: recomputes the inner_mm and outer_mm conditions of YMM_automat smart collections
   * from their original and aftermarket sizes (largest reach + tolerance). Without `write` it
   * only produces the CSV of old and new values. Long runs continue in follow-up jobs that add
   * CSV parts under the first job.
   */
  async "recalc-inner-outer"(shop, payload, jobId) {
    const admin = await adminFor(shop);
    const write = payload.write === true;
    const runId: string = payload.runId ?? jobId;
    const part: number = payload.part ?? 1;
    const started = Date.now();
    const lines: string[] = [];
    const counts = { changed: 0, same: 0, skipped: 0 };
    let after: string | null = payload.after ?? null;
    do {
      const data: any = await gql(admin, INNER_OUTER_PAGE, { after });
      for (const node of data.collections.nodes) {
        if (node.marker?.value !== INNER_OUTER_MARKER) continue;
        const sizesText = [node.original?.value, node.aftermarket?.value].filter(Boolean).join("|");
        const target = innerOuter(parseSizes(sizesText), INNER_OUTER_TOLERANCE_MM);
        const rules: any[] = node.ruleSet?.rules ?? [];
        const inner = rules.find((r) => ruleKey(r) === "custom.inner_mm");
        const outer = rules.find((r) => ruleKey(r) === "custom.outer_mm");
        let status: string;
        if (!target) status = "bez rozměrů";
        else if (!inner || !outer) status = "chybí pravidlo inner/outer";
        else if (Number(inner.condition) === target.inner && Number(outer.condition) === target.outer) status = "beze změny";
        else status = write ? "změněno" : "změní se";
        if (target && inner && outer && status !== "beze změny" && write) {
          const result: any = await gql(admin, COLLECTION_UPDATE_RULES, {
            input: {
              id: node.id,
              ruleSet: {
                appliedDisjunctively: node.ruleSet.appliedDisjunctively,
                rules: rules.map((r) => ({
                  column: r.column,
                  relation: r.relation,
                  condition:
                    r === inner ? String(target.inner) : r === outer ? String(target.outer) : r.condition,
                  ...(r.conditionObject?.metafieldDefinition
                    ? { conditionObjectId: r.conditionObject.metafieldDefinition.id }
                    : {}),
                })),
              },
            },
          });
          assertNoUserErrors("collectionUpdate", result.collectionUpdate.userErrors);
        }
        if (status === "beze změny") counts.same++;
        else if (status === "změněno" || status === "změní se") counts.changed++;
        else counts.skipped++;
        lines.push(
          [
            numericId(node.id),
            csvCell(node.title),
            csvCell(sizesText),
            node.productsCount?.count ?? "",
            inner?.condition ?? "",
            target?.inner ?? "",
            outer?.condition ?? "",
            target?.outer ?? "",
            status,
          ].join(","),
        );
      }
      after = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
    } while (after && Date.now() - started < INNER_OUTER_TIME_BUDGET_MS);

    await db.exportFile.deleteMany({ where: { id: `${runId}-${part}` } });
    await db.exportFile.create({
      data: {
        id: `${runId}-${part}`,
        shop,
        csv: ["collection_id,collection_title,sizes,products_before,old_inner,new_inner,old_outer,new_outer,status", ...lines].join("\n"),
      },
    });
    if (after) await enqueueJob(shop, "recalc-inner-outer", { write, runId, part: part + 1, after });
    return `${write ? "Zapsáno" : "Nanečisto"}: ${write ? "změněno" : "ke změně"} ${counts.changed}, ` +
      `beze změny ${counts.same}, přeskočeno ${counts.skipped}.` +
      (after ? " Pokračuje další úlohou, CSV části přibývají u první úlohy." : "");
  },

  /**
   * Compares the product counts of the collections changed by the last written inner/outer run
   * with the counts recorded before the change. Shopify updates smart collections in the
   * background, so this runs as a separate step some time after the write.
   */
  async "recount-inner-outer"(shop, _payload, jobId) {
    const admin = await adminFor(shop);
    const runs = await db.job.findMany({
      where: { shop, type: "recalc-inner-outer", status: "done" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const run = runs.find((j) => (j.payload as Payload)?.write === true && !(j.payload as Payload)?.runId);
    if (!run) return "Žádný zapsaný přepočet inner/outer.";
    const files = await db.exportFile.findMany({
      where: { shop, id: { startsWith: `${run.id}-` } },
      orderBy: { createdAt: "asc" },
    });
    const rows = files
      .flatMap((f) => f.csv.split("\n").slice(1))
      .map(parseCsvLine)
      .filter((r) => r[8] === "změněno");
    const lines: string[] = [];
    let total = { before: 0, after: 0 };
    for (const batch of chunk(rows, 100)) {
      const data: any = await gql(admin, COLLECTION_COUNTS, {
        ids: batch.map((r) => `gid://shopify/Collection/${r[0]}`),
      });
      batch.forEach((r, i) => {
        const before = Number(r[3]);
        const after = data.nodes[i]?.productsCount?.count ?? 0;
        total = { before: total.before + before, after: total.after + after };
        lines.push([r[0], csvCell(r[1]), r[4], r[5], r[6], r[7], before, after, after - before].join(","));
      });
    }
    await db.exportFile.deleteMany({ where: { id: { startsWith: `${jobId}-` } } });
    await db.exportFile.create({
      data: {
        id: `${jobId}-1`,
        shop,
        csv: [
          "collection_id,collection_title,old_inner,new_inner,old_outer,new_outer,products_before,products_after,difference",
          ...lines,
        ].join("\n"),
      },
    });
    return `${rows.length} kolekcí: produktů před ${total.before}, po ${total.after} (rozdíl ${total.after - total.before}).`;
  },

  async "sort-collection"(shop, payload) {
    const admin = await adminFor(shop);
    return sortCollection(admin, await getRules(shop), payload.collectionId);
  },

  async "sort-all"(shop) {
    const rules = await getRules(shop);
    if (!rules.sorting.enabled) return "Řazení je vypnuté.";
    const collections = await loadRuleCollections(shop);
    for (const { id } of collections) await enqueueJob(shop, "sort-collection", { collectionId: id });
    return `Naplánováno seřazení ${collections.length} kolekcí.`;
  },

  /** Checks every rule collection for products the rules no longer put there, one job each. */
  async "remove-unmatched"(shop, _payload, jobId) {
    const rules = await getRules(shop);
    const remove = rules.removal.enabled;
    // A stale copy could lack values the rules read (like the car), which would remove too much.
    await syncAllCollections(await adminFor(shop), shop, rules);
    const collections = await loadRuleCollections(shop);
    for (const { id } of collections) {
      await enqueueJob(shop, "clean-collection", { collectionId: id, runId: jobId, remove });
    }
    return `Naplánována kontrola ${collections.length} kolekcí` +
      (remove ? ", nevyhovující produkty se odeberou." : " nanečisto (nic se neodebere).");
  },

  async "clean-collection"(shop, payload) {
    const admin = await adminFor(shop);
    return cleanCollection(admin, shop, await getRules(shop), {
      collectionId: payload.collectionId,
      runId: payload.runId,
      remove: payload.remove === true,
    });
  },

  async "add-products"(shop, payload) {
    const admin = await adminFor(shop);
    await addProducts(admin, payload.collectionId, payload.productIds);
    return `Přidáno ${payload.productIds.length} produktů.`;
  },
};

/** Executes a stored job. Throws on failure so Cloud Tasks retries it. */
export async function runJob(jobId: string) {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job || job.status === "done") return;

  await db.job.update({
    where: { id: jobId },
    data: { status: "running", attempts: { increment: 1 }, message: null },
  });
  try {
    const handler = handlers[job.type as JobType];
    if (!handler) throw new Error(`Unknown job type ${job.type}`);
    const message = await handler(job.shop, job.payload as Payload, job.id);
    await db.job.update({ where: { id: jobId }, data: { status: "done", message } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.job.update({ where: { id: jobId }, data: { status: "failed", message: message.slice(0, 2000) } });
    throw error;
  }
}
