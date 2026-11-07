import { toList } from "./engine";
import { SUBCOLLECTION_KEY, type CollectionSnapshot } from "./types";

/**
 * The collections whose products a parent should show: its descendants that have no
 * subcollections themselves. Null when a subcollection is not a known rule collection, so the
 * parent is left alone rather than synced from an incomplete picture.
 */
export function leafDescendants(parentId: string, collections: CollectionSnapshot[]): string[] | null {
  const byId = new Map(collections.map((c) => [c.id, c]));
  const leaves = new Set<string>();
  const seen = new Set<string>([parentId]);
  const stack = toList(byId.get(parentId)?.fields[SUBCOLLECTION_KEY]);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const child = byId.get(id);
    if (!child) return null;
    const children = toList(child.fields[SUBCOLLECTION_KEY]);
    if (children.length === 0) leaves.add(id);
    else stack.push(...children);
  }
  return [...leaves];
}

/** Products to add to a parent and to take out of it, so it holds exactly its leaves' products. */
export function parentDiff(current: Iterable<string>, leafProducts: Iterable<Iterable<string>>) {
  const wanted = new Set<string>();
  for (const products of leafProducts) for (const id of products) wanted.add(id);
  const have = new Set(current);
  return {
    add: [...wanted].filter((id) => !have.has(id)),
    remove: [...have].filter((id) => !wanted.has(id)),
  };
}
