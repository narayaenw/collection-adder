/* eslint-disable @typescript-eslint/no-explicit-any -- Shopify GraphQL responses are untyped JSON. */
import { loadRuleCollections } from "./collections.server";
import { cleanOne } from "./removal.server";
import { productMatchesCollection, productSearchQuery } from "./rules/engine";
export { groupBySearch } from "./rules/groups";
import type { CollectionSnapshot, ProductSnapshot, RuleSet } from "./rules/types";
import { assertNoUserErrors, chunk, gql, type AdminClient } from "./shopify/api.server";
import {
  COLLECTION_ADD_PRODUCTS,
  productSearchPageQuery,
  productsByIdsQuery,
  toProductSnapshot,
} from "./shopify/queries";

const COLLECTION_MEMBER_IDS = `#graphql
  query CollectionMemberIds($id: ID!, $after: String) {
    collection(id: $id) {
      ruleSet { appliedDisjunctively }
      products(first: 250, after: $after) {
        nodes { id }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

async function searchProducts(admin: AdminClient, rules: RuleSet, query: string): Promise<ProductSnapshot[]> {
  const products: ProductSnapshot[] = [];
  let after: string | null = null;
  do {
    const data: any = await gql(admin, productSearchPageQuery(rules), { query, after });
    for (const node of data.products.nodes) products.push(toProductSnapshot(node, rules));
    after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (after);
  return products;
}

/** Ids of a manual collection's products, or why it can't be used. */
async function memberIds(admin: AdminClient, id: string): Promise<string | Set<string>> {
  const ids = new Set<string>();
  let after: string | null = null;
  do {
    const data: any = await gql(admin, COLLECTION_MEMBER_IDS, { id, after });
    if (!data.collection) return "Kolekce nenalezena.";
    if (data.collection.ruleSet) return "Smart kolekce, přeskočeno.";
    for (const node of data.collection.products.nodes) ids.add(node.id);
    const page = data.collection.products.pageInfo;
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);
  return ids;
}

async function readProducts(admin: AdminClient, rules: RuleSet, ids: string[]) {
  const products: ProductSnapshot[] = [];
  const titles = new Map<string, string>();
  const query = productsByIdsQuery(rules);
  for (const batch of chunk(ids, 250)) {
    const data: any = await gql(admin, query, { ids: batch });
    for (const node of data.nodes ?? []) {
      if (!node?.id) continue; // Deleted meanwhile.
      products.push(toProductSnapshot(node, rules));
      titles.set(node.id, node.title ?? "");
    }
  }
  return { products, titles };
}

export interface GroupResult {
  /** Products the shared search returned (read once for the whole group). */
  searched: number;
  collections: number;
  added: number;
  removal: { checked: number; unmatched: number; skipped: string[] };
  /** Collections whose products changed, for sorting. */
  changed: Set<string>;
}

/**
 * Fills and/or cleans collections that share one product search: the search runs once, then
 * each collection only has its product ids read. Missing matches are added. Products in a
 * collection that the search did not return are read with their fields and checked by the rules
 * before removal, so a product the search missed is never taken out by mistake.
 */
export async function evaluateGroup(
  admin: AdminClient,
  shop: string,
  rules: RuleSet,
  collectionIds: string[],
  options: { add: boolean; removal?: { runId: string; remove: boolean } },
): Promise<GroupResult> {
  const byId = new Map((await loadRuleCollections(shop)).map((c) => [c.id, c]));
  const result: GroupResult = {
    searched: 0,
    collections: 0,
    added: 0,
    removal: { checked: 0, unmatched: 0, skipped: [] },
    changed: new Set(),
  };

  const collections = collectionIds.map((id) => byId.get(id)).filter((c): c is CollectionSnapshot => !!c);
  result.removal.skipped.push(
    ...collectionIds.filter((id) => !byId.has(id)).map(() => "Kolekce není v přehledu kolekcí s pravidly, přeskočeno."),
  );
  if (collections.length === 0) return result;

  // Members of a group share the search query, so the first one stands for all.
  const query = productSearchQuery(collections[0], rules);
  const found = query === null ? [] : await searchProducts(admin, rules, query);
  result.searched = found.length;

  for (const collection of collections) {
    const startedAt = new Date();
    const members = await memberIds(admin, collection.id);
    if (typeof members === "string") {
      result.removal.skipped.push(members);
      continue;
    }
    result.collections++;
    const matched = new Set(
      found.filter((p) => productMatchesCollection(p, collection, rules)).map((p) => p.id),
    );

    if (options.add) {
      const toAdd = [...matched].filter((id) => !members.has(id));
      for (const ids of chunk(toAdd, 250)) {
        const data = await gql(admin, COLLECTION_ADD_PRODUCTS, { id: collection.id, productIds: ids });
        assertNoUserErrors("collectionAddProductsV2", data.collectionAddProductsV2.userErrors);
      }
      result.added += toAdd.length;
      if (toAdd.length > 0) result.changed.add(collection.id);
    }

    if (options.removal) {
      // Only products the search did not confirm need their fields read; the rules decide.
      const candidates = [...members].filter((id) => !matched.has(id));
      const contents = await readProducts(admin, rules, candidates);
      const counts = await cleanOne(
        admin,
        shop,
        rules,
        { collectionId: collection.id, ...options.removal },
        { contents, startedAt },
      );
      if (typeof counts === "string") {
        result.removal.skipped.push(counts);
      } else {
        result.removal.checked += members.size;
        result.removal.unmatched += counts.unmatched;
        if (counts.unmatched > 0 && options.removal.remove) result.changed.add(collection.id);
      }
    }
  }
  return result;
}
