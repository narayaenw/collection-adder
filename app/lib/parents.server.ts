/* eslint-disable @typescript-eslint/no-explicit-any -- Shopify GraphQL responses are untyped JSON. */
import { loadAllRuleCollections } from "./collections.server";
import { isParentCollection } from "./rules/engine";
import { leafDescendants, parentDiff } from "./rules/parents";
import { assertNoUserErrors, chunk, gql, type AdminClient } from "./shopify/api.server";
import { COLLECTION_ADD_PRODUCTS, COLLECTION_PRODUCT_IDS, COLLECTION_REMOVE_PRODUCTS } from "./shopify/queries";

async function productIds(admin: AdminClient, collectionId: string): Promise<Set<string> | null> {
  const ids = new Set<string>();
  let after: string | null = null;
  do {
    const data: any = await gql(admin, COLLECTION_PRODUCT_IDS, { id: collectionId, after });
    if (!data.collection) return null;
    for (const node of data.collection.products.nodes) ids.add(node.id);
    const page = data.collection.products.pageInfo;
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);
  return ids;
}

/** All parent collections in the local copy. */
export async function parentCollectionIds(shop: string): Promise<string[]> {
  return (await loadAllRuleCollections(shop)).filter(isParentCollection).map((c) => c.id);
}

/**
 * Makes a parent (manual) collection hold exactly the products of its leaf subcollections:
 * Shopify does not pass products up to manual collections, so the app does it.
 */
export async function syncParent(admin: AdminClient, shop: string, parentId: string): Promise<{ message: string; changed: boolean }> {
  const skip = (message: string) => ({ message, changed: false });
  const collections = await loadAllRuleCollections(shop);
  const parent = collections.find((c) => c.id === parentId);
  if (!parent || !isParentCollection(parent)) return skip("Není nadřazená kolekce, přeskočeno.");
  const leaves = leafDescendants(parentId, collections);
  if (!leaves) return skip("Podkolekce není v přehledu kolekcí s pravidly, přeskočeno.");
  if (leaves.length === 0) return skip("Bez podkolekcí, přeskočeno.");

  const leafProducts: Set<string>[] = [];
  for (const id of leaves) {
    const ids = await productIds(admin, id);
    if (!ids) return skip(`Podkolekce ${id} nenalezena, přeskočeno.`);
    leafProducts.push(ids);
  }
  const current = await productIds(admin, parentId);
  if (!current) return skip("Kolekce nenalezena.");
  const { add, remove } = parentDiff(current, leafProducts);

  for (const ids of chunk(add, 250)) {
    const data = await gql(admin, COLLECTION_ADD_PRODUCTS, { id: parentId, productIds: ids });
    assertNoUserErrors("collectionAddProductsV2", data.collectionAddProductsV2.userErrors);
  }
  for (const ids of chunk(remove, 250)) {
    const data = await gql(admin, COLLECTION_REMOVE_PRODUCTS, { id: parentId, productIds: ids });
    assertNoUserErrors("collectionRemoveProducts", data.collectionRemoveProducts.userErrors);
  }
  return {
    message: `Podkolekcí ${leaves.length}, přidáno ${add.length}, odebráno ${remove.length}.`,
    changed: add.length + remove.length > 0,
  };
}
