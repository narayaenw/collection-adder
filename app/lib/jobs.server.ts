/* eslint-disable @typescript-eslint/no-explicit-any -- Shopify GraphQL responses are untyped JSON. */
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { syncAllCollections, syncCollection, loadRuleCollections } from "./collections.server";
import { evaluateProduct } from "./evaluate.server";
import { enqueueJob, type JobType } from "./queue.server";
import {
  buildAncestors,
  createMatcher,
  isVendorExcluded,
  productMatchesCollection,
  productSearchQuery,
  toList,
  withAncestors,
} from "./rules/engine";
import type { CollectionSnapshot, ProductSnapshot, RuleSet } from "./rules/types";
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
 * Reads all products once and returns, per collection, the products that should be added:
 * those matching its rules and those in any of its subcollections (at any depth).
 */
async function planAdditions(admin: AdminClient, shop: string, collectionIds?: Set<string>) {
  const rules = await getRules(shop);
  const collections = await loadRuleCollections(shop);
  const { products, memberships, add } = productRowParser(rules);
  await forEachBulkRow(admin, productsBulkQuery(rules), add);

  // Matching runs over all collections because a subcollection's products reach its parents.
  const match = createMatcher(collections, rules);
  const ancestors = buildAncestors(collections, rules);
  const additions = new Map<string, string[]>();
  for (const product of products) {
    // Excluded vendors are never added, not even through a subcollection.
    if (isVendorExcluded(product, rules)) continue;
    const current = memberships.get(product.id);
    for (const collectionId of withAncestors([...match(product), ...(current ?? [])], ancestors)) {
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

/** Ids of all collections below the given one in the category tree (any depth). */
function descendantsOf(id: string, byId: Map<string, CollectionSnapshot>, rules: RuleSet): string[] {
  if (!rules.subcollectionKey) return [];
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const child of toList(byId.get(current)?.fields[rules.subcollectionKey])) {
      if (seen.has(child)) continue;
      seen.add(child);
      stack.push(child);
    }
  }
  seen.delete(id);
  return [...seen];
}

/**
 * Fills collections using Shopify product search: only products that can match the rules are
 * read, so one collection takes seconds instead of a full export. A collection with
 * subcollections also gets every product its subcollections hold or match. New products also
 * go to the collection's ancestors. Collections missing from the app's overview are returned
 * for the full export instead.
 */
async function evaluateBySearch(admin: AdminClient, shop: string, rules: RuleSet, ids: Set<string>) {
  const collections = await loadRuleCollections(shop);
  const byId = new Map(collections.map((c) => [c.id, c]));
  const ancestors = buildAncestors(collections, rules);

  const current = new Map<string, Set<string>>();
  const currentOf = async (id: string) => {
    let set = current.get(id);
    if (!set) current.set(id, (set = new Set((await collectionProducts(admin, id)).map((p) => p.id))));
    return set;
  };

  let checked = 0;
  const matchedOf = new Map<string, string[]>();
  const searchMatches = async (collection: CollectionSnapshot) => {
    const cached = matchedOf.get(collection.id);
    if (cached) return cached;
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
    matchedOf.set(collection.id, matched);
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
    const matched = new Set(await searchMatches(collection));
    for (const childId of descendantsOf(id, byId, rules)) {
      const child = byId.get(childId);
      if (child) for (const p of await searchMatches(child)) matched.add(p);
      for (const product of await collectionProducts(admin, childId)) {
        if (!isVendorExcluded(product, rules)) matched.add(product.id);
      }
    }

    for (const target of [id, ...(ancestors.get(id) ?? [])]) {
      const existing = await currentOf(target);
      const toAdd = [...matched].filter((p) => !existing.has(p));
      await addProducts(admin, target, toAdd);
      for (const p of toAdd) existing.add(p);
      added += toAdd.length;
      if (toAdd.length > 0) changed.add(target);
    }
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
   * Every collection-product pair the rules match directly (including pairs already in place)
   * as CSV, without changing anything. Subcollections and current memberships are left out,
   * which keeps the product export small and fast.
   */
  async "export-plan"(shop, _payload, jobId) {
    const admin = await adminFor(shop);
    const rules = await getRules(shop);
    await syncAllCollections(admin, shop, rules);
    const collections = await loadRuleCollections(shop);
    const match = createMatcher(collections, rules);
    const additions = new Map<string, string[]>();
    let productCount = 0;
    await forEachBulkRow(admin, productsBulkQuery(rules, { withCollections: false }), (row) => {
      if (typeof row.id !== "string" || !row.id.includes("/Product/")) return;
      productCount++;
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
