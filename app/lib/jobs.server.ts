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
import type { RuleSet } from "./rules/types";
import { getRules } from "./settings.server";
import { assertNoUserErrors, chunk, gql, runBulkQuery, type AdminClient } from "./shopify/api.server";
import {
  COLLECTION_ADD_PRODUCTS,
  COLLECTION_PRODUCT_IDS,
  parseProductRows,
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
  const { products, memberships } = parseProductRows(
    await runBulkQuery(admin, productsBulkQuery(rules)),
    rules,
  );

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

async function collectionProductIds(admin: AdminClient, id: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let after: string | null = null;
  do {
    const data: any = await gql(admin, COLLECTION_PRODUCT_IDS, { id, after });
    const connection = data.collection?.products;
    if (!connection) break;
    for (const node of connection.nodes) ids.add(node.id);
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return ids;
}

/**
 * Fills collections without subcollections using Shopify product search: only products that
 * can match the rules are read, so one collection takes seconds instead of a full export.
 * New products also go to the collection's ancestors. Collections with subcollections need
 * every product in the subtree, so they are returned for the full export instead.
 */
async function evaluateBySearch(admin: AdminClient, shop: string, rules: RuleSet, ids: Set<string>) {
  const collections = await loadRuleCollections(shop);
  const byId = new Map(collections.map((c) => [c.id, c]));
  const ancestors = buildAncestors(collections, rules);
  const hasChildren = (id: string) =>
    !!rules.subcollectionKey && toList(byId.get(id)?.fields[rules.subcollectionKey]).length > 0;

  const current = new Map<string, Set<string>>();
  const currentOf = async (id: string) => {
    let set = current.get(id);
    if (!set) current.set(id, (set = await collectionProductIds(admin, id)));
    return set;
  };

  const rest = new Set<string>();
  let checked = 0;
  let added = 0;
  for (const id of ids) {
    const collection = byId.get(id);
    if (!collection || hasChildren(id)) {
      rest.add(id);
      continue;
    }
    const query = productSearchQuery(collection, rules);
    if (query === null) continue;

    const matched: string[] = [];
    let after: string | null = null;
    do {
      const data: any = await gql(admin, productSearchPageQuery(rules), { query, after });
      for (const node of data.products.nodes) {
        checked++;
        const product = toProductSnapshot(node, rules);
        if (productMatchesCollection(product, collection, rules)) matched.push(product.id);
      }
      after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    } while (after);

    for (const target of [id, ...(ancestors.get(id) ?? [])]) {
      const existing = await currentOf(target);
      const toAdd = matched.filter((p) => !existing.has(p));
      await addProducts(admin, target, toAdd);
      for (const p of toAdd) existing.add(p);
      added += toAdd.length;
    }
  }
  return { checked, added, rest };
}

/** Queues additions planned from a full product export. */
async function queueAdditions(shop: string, additions: Map<string, string[]>) {
  let products = 0;
  for (const [collectionId, productIds] of additions) {
    for (const ids of chunk(productIds, 250)) {
      await enqueueJob(shop, "add-products", { collectionId, productIds: ids });
      products += ids.length;
    }
  }
  return products;
}

const handlers: Record<JobType, (shop: string, payload: Payload) => Promise<string>> = {
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
    const message = await handler(job.shop, job.payload as Payload);
    await db.job.update({ where: { id: jobId }, data: { status: "done", message } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.job.update({ where: { id: jobId }, data: { status: "failed", message: message.slice(0, 2000) } });
    throw error;
  }
}
