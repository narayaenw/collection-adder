/* eslint-disable @typescript-eslint/no-explicit-any -- Shopify GraphQL responses are untyped JSON. */
import db from "../db.server";
import { recordCheck } from "./changes.server";
import { toList } from "./rules/engine";
import { unmatchedProducts } from "./rules/removal";
import { SUBCOLLECTION_KEY, type CollectionSnapshot, type FieldMap, type RuleSet } from "./rules/types";
import { assertNoUserErrors, chunk, gql, type AdminClient } from "./shopify/api.server";
import { COLLECTION_REMOVE_PRODUCTS, collectionRuleProductsQuery, toProductSnapshot } from "./shopify/queries";

/** The collection and all its subcollections (through the subcollection metafield) from the local copy. */
async function collectionTree(shop: string, id: string) {
  const load = async (ids: string[]) =>
    (
      await db.ruleCollection.findMany({
        where: { shop, id: { in: ids } },
        select: { id: true, title: true, fields: true },
      })
    ).map((r): CollectionSnapshot => ({ id: r.id, title: r.title, fields: r.fields as FieldMap }));

  const [root] = await load([id]);
  if (!root) return null;
  const seen = new Set([id]);
  const descendants: CollectionSnapshot[] = [];
  let level = [root];
  while (level.length > 0) {
    const next = [
      ...new Set(level.flatMap((c) => toList(c.fields[SUBCOLLECTION_KEY]))),
    ].filter((childId) => !seen.has(childId));
    next.forEach((childId) => seen.add(childId));
    level = next.length ? await load(next) : [];
    descendants.push(...level);
  }
  return { root, descendants };
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
  return `${result.checked} produktů, nevyhovuje ${result.unmatched}` +
    (result.unmatched ? (options.remove ? ", odebráno." : " (jen nanečisto).") : ".");
}

/** Like cleanCollection, but returns counts (or the reason the collection was skipped). */
export async function cleanOne(
  admin: AdminClient,
  shop: string,
  rules: RuleSet,
  { collectionId, runId, remove }: { collectionId: string; runId: string; remove: boolean },
): Promise<string | { checked: number; unmatched: number }> {
  const startedAt = new Date();
  const tree = await collectionTree(shop, collectionId);
  if (!tree) return "Kolekce není v přehledu kolekcí s pravidly, přeskočeno.";

  const query = collectionRuleProductsQuery(rules);
  const products = [];
  const titles = new Map<string, string>();
  let after: string | null = null;
  do {
    const data: any = await gql(admin, query, { id: collectionId, after });
    if (!data.collection) return "Kolekce nenalezena.";
    if (data.collection.ruleSet) return "Smart kolekce, přeskočeno.";
    for (const node of data.collection.products.nodes) {
      products.push(toProductSnapshot(node, rules));
      titles.set(node.id, node.title ?? "");
    }
    const page = data.collection.products.pageInfo;
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);

  const unmatched = unmatchedProducts(tree.root, tree.descendants, products, rules);

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
        collectionTitle: tree.root.title ?? "",
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
