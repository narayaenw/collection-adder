/* eslint-disable @typescript-eslint/no-explicit-any -- Shopify GraphQL responses are untyped JSON. */
import db from "../db.server";
import { recordCheck } from "./changes.server";
import { loadRuleCollection } from "./collections.server";
import { isParentCollection } from "./rules/engine";
import { unmatchedProducts } from "./rules/removal";
import type { ProductSnapshot, RuleSet } from "./rules/types";
import { assertNoUserErrors, chunk, gql, type AdminClient } from "./shopify/api.server";
import { COLLECTION_REMOVE_PRODUCTS, collectionRuleProductsQuery, toProductSnapshot } from "./shopify/queries";

/** Removal counts as a sentence for job results. */
export function removalSummary(counts: { checked: number; unmatched: number }, remove: boolean) {
  return `${counts.checked} produktů, nevyhovuje ${counts.unmatched}` +
    (counts.unmatched ? (remove ? ", odebráno." : " (jen nanečisto).") : ".");
}

/**
 * Finds the products of one rule collection that the rules no longer put there and records
 * them under the run. With `remove` they are also taken out of the collection.
 */
export async function cleanCollection(
  admin: AdminClient,
  shop: string,
  rules: RuleSet,
  options: { collectionId: string; runId: string; remove: boolean },
) {
  const result = await cleanOne(admin, shop, rules, options);
  if (typeof result === "string") return result;
  return removalSummary(result, options.remove);
}

/** Products of a collection with the fields the rules read, read once for filling and removal. */
export interface CollectionContents {
  products: ProductSnapshot[];
  titles: Map<string, string>;
}

/** Current products of a manual collection with rule fields, or why it can't be used. */
export async function readCollectionContents(
  admin: AdminClient,
  rules: RuleSet,
  collectionId: string,
): Promise<string | CollectionContents> {
  const query = collectionRuleProductsQuery(rules);
  const products: ProductSnapshot[] = [];
  const titles = new Map<string, string>();
  let after: string | null = null;
  do {
    const data: any = await gql(admin, query, { id: collectionId, after });
    if (!data.collection) return "Kolekce nenalezena.";
    if (data.collection.ruleSet) return "Smart kolekce, přeskočeno.";
    for (const node of data.collection.products.nodes) {
      // Pages can repeat products when the collection is reordered meanwhile (e.g. by a sort job).
      if (titles.has(node.id)) continue;
      products.push(toProductSnapshot(node, rules));
      titles.set(node.id, node.title ?? "");
    }
    const page = data.collection.products.pageInfo;
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);
  return { products, titles };
}

/**
 * Like cleanCollection, but returns counts (or the reason the collection was skipped).
 * `preread` passes products already read, read no earlier than its `startedAt`.
 */
export async function cleanOne(
  admin: AdminClient,
  shop: string,
  rules: RuleSet,
  { collectionId, runId, remove }: { collectionId: string; runId: string; remove: boolean },
  preread?: { contents: CollectionContents; startedAt: Date },
): Promise<string | { checked: number; unmatched: number }> {
  const startedAt = preread?.startedAt ?? new Date();
  const collection = await loadRuleCollection(shop, collectionId);
  if (!collection) return "Kolekce není v přehledu kolekcí s pravidly, přeskočeno.";
  if (isParentCollection(collection)) return "Nadřazená kolekce, přeskočeno.";

  const contents = preread?.contents ?? (await readCollectionContents(admin, rules, collectionId));
  if (typeof contents === "string") return contents;
  const { products, titles } = contents;

  const unmatched = unmatchedProducts(collection, products, rules);

  // A retried job records the collection again.
  await db.removalItem.deleteMany({ where: { runId, collectionId } });
  if (remove) {
    for (const ids of chunk(unmatched.map((p) => p.id), 250)) {
      const data = await gql(admin, COLLECTION_REMOVE_PRODUCTS, { id: collectionId, productIds: ids });
      assertNoUserErrors("collectionRemoveProducts", data.collectionRemoveProducts.userErrors);
    }
  }
  if (unmatched.length > 0) {
    await db.removalItem.createMany({
      data: unmatched.map((p) => ({
        shop,
        runId,
        collectionId,
        collectionTitle: collection.title ?? "",
        productId: p.id,
        productTitle: titles.get(p.id) ?? "",
        vendor: p.fields.vendor ?? "",
        removed: remove,
      })),
    });
  }
  await recordCheck(shop, "clean", rules, collectionId, startedAt);
  return { checked: products.length, unmatched: unmatched.length };
}
