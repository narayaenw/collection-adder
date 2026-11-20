/* eslint-disable @typescript-eslint/no-explicit-any -- Shopify GraphQL responses are untyped JSON. */
import { getRuleMatcher } from "./collections.server";
import { isVendorExcluded } from "./rules/engine";
import { hasIncludedStatus } from "./rules/types";
import { getRules } from "./settings.server";
import { assertNoUserErrors, chunk, gql, withGqlStats, type AdminClient, type GqlStats } from "./shopify/api.server";
import {
  PRODUCT_COLLECTIONS_QUERY,
  PRODUCT_JOIN_COLLECTIONS,
  productQuery,
  toProductSnapshot,
} from "./shopify/queries";

async function currentCollectionIds(admin: AdminClient, productId: string) {
  const ids = new Set<string>();
  let after: string | null = null;
  do {
    const data: any = await gql(admin, PRODUCT_COLLECTIONS_QUERY, { id: productId, after });
    const connection = data.product?.collections;
    if (!connection) break;
    for (const node of connection.nodes) ids.add(node.id);
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return ids;
}

/** Milliseconds of one step; Shopify steps also carry their bucket waits and query cost. */
type Step = { ms: number; waitMs?: number; cost?: number; calls?: number; ids?: number };

function shopifyStep(started: number, stats: GqlStats): Step {
  return { ms: Date.now() - started, waitMs: stats.waitMs, cost: stats.cost, calls: stats.calls };
}

/**
 * Matches one product against all rule collections (from the local copy, cached in memory) and
 * joins the collections it is not in yet. Each step is timed and logged, so slow runs show where
 * the time goes.
 */
export async function evaluateProduct(admin: AdminClient, shop: string, productId: string) {
  const started = Date.now();
  const steps: Record<string, Step | Step[] | boolean | number> = {};
  const log = (result: Record<string, unknown>) =>
    console.log(JSON.stringify({
      evaluateProduct: { productId, totalMs: Date.now() - started, ...result, steps },
    }));

  let t = Date.now();
  const rules = await getRules(shop);
  steps.rules = { ms: Date.now() - t };

  t = Date.now();
  const read = await withGqlStats(() => gql(admin, productQuery(rules), { id: productId }));
  steps.product = shopifyStep(t, read.stats);
  const data = read.result;
  if (!data.product) {
    log({ found: false });
    return null;
  }

  const product = toProductSnapshot(data.product, rules);
  // Drafts, archived and unlisted products stay out of rule collections.
  if (isVendorExcluded(product, rules) || !hasIncludedStatus(product)) {
    log({ skipped: true });
    return { matched: 0, added: 0 };
  }

  t = Date.now();
  const matcher = await getRuleMatcher(shop, rules);
  steps.collections = { ms: Date.now() - t };
  steps.cached = matcher.cached;
  steps.collectionCount = matcher.count;

  t = Date.now();
  const matched = matcher.match(product);
  steps.match = { ms: Date.now() - t };

  t = Date.now();
  const listed = await withGqlStats(() => currentCollectionIds(admin, productId));
  steps.current = shopifyStep(t, listed.stats);
  const current = listed.result;
  const toJoin = matched.filter((id) => !current.has(id));

  const joins: Step[] = [];
  steps.joins = joins;
  for (const ids of chunk(toJoin, 250)) {
    t = Date.now();
    const joined = await withGqlStats(() =>
      gql(admin, PRODUCT_JOIN_COLLECTIONS, { product: { id: productId, collectionsToJoin: ids } }),
    );
    joins.push({ ...shopifyStep(t, joined.stats), ids: ids.length });
    assertNoUserErrors("productUpdate", joined.result.productUpdate.userErrors);
  }
  log({ matched: matched.length, current: current.size, added: toJoin.length });
  return { matched: matched.length, added: toJoin.length };
}

/** Products read at once while planning a list evaluation; the shared cost bucket paces them. */
const PLAN_CONCURRENCY = 8;

/**
 * Plans a product list evaluation per collection: reads each product and its current collections,
 * matches it and returns, per collection, the products to add. Writing per collection
 * (collectionAddProductsV2, up to 250 products a call) replaces one productUpdate per product,
 * which costs about 50 ms for every collection joined.
 */
export async function planProductAdditions(admin: AdminClient, shop: string, productIds: string[]) {
  const started = Date.now();
  const rules = await getRules(shop);
  const matcher = await getRuleMatcher(shop, rules);
  const additions = new Map<string, string[]>();
  let found = 0;
  let skipped = 0;
  let matchedPairs = 0;
  let next = 0;

  const worker = async () => {
    while (next < productIds.length) {
      const productId = productIds[next++];
      const data = await gql(admin, productQuery(rules), { id: productId });
      if (!data.product) continue;
      found++;
      const product = toProductSnapshot(data.product, rules);
      if (isVendorExcluded(product, rules) || !hasIncludedStatus(product)) {
        skipped++;
        continue;
      }
      const matched = matcher.match(product);
      matchedPairs += matched.length;
      if (matched.length === 0) continue;
      const current = await currentCollectionIds(admin, productId);
      for (const collectionId of matched) {
        if (current.has(collectionId)) continue;
        const list = additions.get(collectionId);
        if (list) list.push(productId);
        else additions.set(collectionId, [productId]);
      }
    }
  };
  const { stats } = await withGqlStats(() =>
    Promise.all(Array.from({ length: PLAN_CONCURRENCY }, worker)),
  );

  let pairs = 0;
  for (const list of additions.values()) pairs += list.length;
  console.log(JSON.stringify({
    planProductAdditions: {
      products: productIds.length, found, skipped, matchedPairs, pairs, collections: additions.size,
      totalMs: Date.now() - started, cached: matcher.cached, waitMs: stats.waitMs, calls: stats.calls,
    },
  }));
  return { additions, found, skipped, matchedPairs, pairs };
}
