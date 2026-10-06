/* eslint-disable @typescript-eslint/no-explicit-any -- Shopify GraphQL responses are untyped JSON. */
import { loadRuleCollections } from "./collections.server";
import { buildAncestors, createMatcher, isVendorExcluded, withAncestors } from "./rules/engine";
import { getRules } from "./settings.server";
import { queueSorting } from "./sort.server";
import { assertNoUserErrors, chunk, gql, type AdminClient } from "./shopify/api.server";
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

/**
 * Matches one product against all rule collections (from the local copy) and joins the
 * collections it is not in yet, plus the parents of every collection it is in. Fast enough to
 * run straight from the admin.
 */
export async function evaluateProduct(admin: AdminClient, shop: string, productId: string) {
  const rules = await getRules(shop);
  const data = await gql(admin, productQuery(rules), { id: productId });
  if (!data.product) return null;

  const product = toProductSnapshot(data.product, rules);
  if (isVendorExcluded(product, rules)) return { matched: 0, added: 0 };
  const collections = await loadRuleCollections(shop);
  const matched = createMatcher(collections, rules)(product);
  const current = await currentCollectionIds(admin, productId);
  const targets = withAncestors([...matched, ...current], buildAncestors(collections, rules));
  const toJoin = [...targets].filter((id) => !current.has(id));

  for (const ids of chunk(toJoin, 250)) {
    const result = await gql(admin, PRODUCT_JOIN_COLLECTIONS, {
      product: { id: productId, collectionsToJoin: ids },
    });
    assertNoUserErrors("productUpdate", result.productUpdate.userErrors);
  }
  await queueSorting(shop, rules, toJoin);
  return { matched: matched.length, added: toJoin.length };
}
