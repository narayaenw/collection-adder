import { equalityKey, normalizeText, toList, toNumber } from "./engine";
import type { FieldMap, SortSettings } from "./types";

export interface SortProduct {
  id: string;
  /** Raw values keyed by the sort settings' metafield keys, plus "tags". */
  fields: FieldMap;
}

export interface Move {
  id: string;
  newPosition: string;
}

/** 0 = made for the collection's car, 1 = tagged, 2 = the rest. */
export function sortGroup(product: SortProduct, collectionCars: Set<string>, settings: SortSettings): number {
  if (toList(product.fields[settings.productMatchKey]).some((car) => collectionCars.has(equalityKey(car)))) {
    return 0;
  }
  const tag = normalizeText(settings.tag);
  if (tag && toList(product.fields.tags).some((t) => normalizeText(t) === tag)) return 1;
  return 2;
}

function rankOf(product: SortProduct, settings: SortSettings): number | null {
  const raw = product.fields[settings.rankKey];
  return raw === null || raw === undefined ? null : toNumber(String(raw));
}

/**
 * Product ids in the order they should have in the collection. `products` is the current order;
 * the sort is stable, so ties keep it.
 */
export function desiredOrder(
  products: SortProduct[],
  collection: FieldMap,
  settings: SortSettings,
): string[] {
  const cars = new Set(toList(collection[settings.collectionMatchKey]).map(equalityKey));
  return products
    .map((product, index) => ({
      id: product.id,
      index,
      group: sortGroup(product, cars, settings),
      rank: rankOf(product, settings),
    }))
    .sort((a, b) => {
      if (a.group !== b.group) return a.group - b.group;
      if (a.rank !== b.rank) {
        if (a.rank === null) return 1;
        if (b.rank === null) return -1;
        return b.rank - a.rank;
      }
      return a.index - b.index;
    })
    .map((p) => p.id);
}

/**
 * Moves that turn `current` into `desired` when Shopify applies them one after another. Only
 * products out of place are moved, so an already sorted collection needs none.
 */
export function reorderMoves(current: string[], desired: string[]): Move[] {
  const order = [...current];
  const moves: Move[] = [];
  for (let i = 0; i < desired.length; i++) {
    if (order[i] === desired[i]) continue;
    const from = order.indexOf(desired[i], i);
    if (from < 0) continue;
    order.splice(from, 1);
    order.splice(i, 0, desired[i]);
    moves.push({ id: desired[i], newPosition: String(i) });
  }
  return moves;
}
