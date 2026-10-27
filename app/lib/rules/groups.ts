import { productSearchQuery } from "./engine";
import type { CollectionSnapshot, RuleSet } from "./types";

/** At most this many collections share one job, so a large group stays well under the time limit. */
export const GROUP_JOB_SIZE = 50;

/**
 * Collections that read the same products from Shopify: the same search query. Their car
 * (and anything else the search leaves out) is still checked per collection.
 */
export function groupBySearch(collections: CollectionSnapshot[], rules: RuleSet) {
  const groups = new Map<string, string[]>();
  for (const collection of collections) {
    const key = productSearchQuery(collection, rules) ?? "";
    const list = groups.get(key);
    if (list) list.push(collection.id);
    else groups.set(key, [collection.id]);
  }
  return [...groups.values()].flatMap((ids) => chunkIds(ids));
}

function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += GROUP_JOB_SIZE) chunks.push(ids.slice(i, i + GROUP_JOB_SIZE));
  return chunks;
}
