/* eslint-disable @typescript-eslint/no-explicit-any -- Shopify GraphQL responses are untyped JSON. */
import { enqueueJob } from "./queue.server";
import { desiredOrder, reorderMoves, type SortProduct } from "./rules/sorting";
import type { RuleSet } from "./rules/types";
import { assertNoUserErrors, chunk, gql, sleep, type AdminClient } from "./shopify/api.server";
import {
  COLLECTION_REORDER_PRODUCTS,
  COLLECTION_SET_MANUAL_SORT,
  JOB_STATUS,
  readMetafields,
  sortCollectionQuery,
} from "./shopify/queries";

/** Waits for a Shopify background job, so the next batch of moves sees the previous one. */
async function waitForJob(admin: AdminClient, id: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const data = await gql(admin, JOB_STATUS, { id });
    if (!data.job || data.job.done) return;
    await sleep(1000);
  }
  throw new Error(`Shopify job ${id} did not finish.`);
}

/**
 * Orders a collection's products by the sort settings: switches it to manual sorting and moves
 * only the products that are out of place.
 */
export async function sortCollection(admin: AdminClient, rules: RuleSet, collectionId: string) {
  const settings = rules.sorting;
  if (!settings.enabled) return "Řazení je vypnuté.";

  const collectionKeys = [settings.collectionSizeKey, settings.collectionMatchKey];
  const productKeys = [settings.rankKey, settings.productSizeKey, settings.productMatchKey];
  const query = sortCollectionQuery(collectionKeys, productKeys);

  let collection: any = null;
  const products: SortProduct[] = [];
  let after: string | null = null;
  do {
    const data: any = await gql(admin, query, { id: collectionId, after });
    if (!data.collection) return "Kolekce nenalezena.";
    collection ??= data.collection;
    for (const node of data.collection.products.nodes) {
      products.push({
        id: node.id,
        fields: { ...readMetafields(node, productKeys), tags: JSON.stringify(node.tags ?? []) },
      });
    }
    const page = data.collection.products.pageInfo;
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);

  if (collection.ruleSet) return "Smart kolekce, řazení přeskočeno.";

  const collectionFields = Object.fromEntries(
    collectionKeys.map((key, i) => [key, collection[`c${i}`]?.value ?? null]),
  );
  const current = products.map((p) => p.id);
  const moves = reorderMoves(current, desiredOrder(products, collectionFields, settings));

  if (collection.sortOrder !== "MANUAL") {
    const data = await gql(admin, COLLECTION_SET_MANUAL_SORT, {
      input: { id: collectionId, sortOrder: "MANUAL" },
    });
    assertNoUserErrors("collectionUpdate", data.collectionUpdate.userErrors);
  }

  for (const batch of chunk(moves, 250)) {
    const data = await gql(admin, COLLECTION_REORDER_PRODUCTS, { id: collectionId, moves: batch });
    assertNoUserErrors("collectionReorderProducts", data.collectionReorderProducts.userErrors);
    const job = data.collectionReorderProducts.job;
    if (job && !job.done) await waitForJob(admin, job.id);
  }

  return moves.length === 0
    ? `${products.length} produktů, pořadí už sedí.`
    : `${products.length} produktů, přesunuto ${moves.length}.`;
}

/** Collection additions run as Shopify background jobs, so sorting waits for them a while. */
const SORT_DELAY_SECONDS = 120;

/** Queues sorting of collections that just got new products. */
export async function queueSorting(shop: string, rules: RuleSet, collectionIds: Iterable<string>) {
  if (!rules.sorting.enabled) return;
  for (const collectionId of new Set(collectionIds)) {
    await enqueueJob(shop, "sort-collection", { collectionId }, { delaySeconds: SORT_DELAY_SECONDS });
  }
}
