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

export interface WheelSize {
  width: number | null;
  diameter: number;
  et: number | null;
}

/**
 * Parses an OE size like "8Jx20 ET24" (width 8, diameter 20, ET 24). A plain "20" is just a
 * diameter. Returns null for anything else.
 */
export function parseWheelSize(value: string): WheelSize | null {
  const num = (raw: string | undefined) => (raw === undefined ? null : toNumber(raw));
  const full = /(\d+(?:[.,]\d+)?)\s*J?\s*x\s*(\d+(?:[.,]\d+)?)(?:.*?ET\s*([-+]?\d+(?:[.,]\d+)?))?/i.exec(value);
  if (full) return { width: num(full[1]), diameter: num(full[2])!, et: num(full[3]) };
  const diameter = toNumber(value);
  return diameter === null ? null : { width: null, diameter, et: null };
}

const numbers = (raw: string | null | undefined) =>
  toList(raw).map(toNumber).filter((n): n is number => n !== null);

/** Whether the product has one of the sizes: width, diameter and ET all equal (where given). */
function hasSize(product: SortProduct, sizes: WheelSize[], settings: SortSettings): boolean {
  if (sizes.length === 0) return false;
  const diameters = numbers(product.fields[settings.productSizeKey]);
  const widths = numbers(product.fields[settings.productWidthKey]);
  const ets = numbers(product.fields[settings.productEtKey]);
  return sizes.some(
    (s) =>
      diameters.includes(s.diameter) &&
      (s.width === null || widths.includes(s.width)) &&
      (s.et === null || ets.includes(s.et)),
  );
}

const hasAny = (raw: string | null | undefined, keys: Set<string>) =>
  toList(raw).some((value) => keys.has(equalityKey(value)));

/**
 * 0 = original size and car, 1 = original size, 2 = made for the car, 3 = tagged, 4 = the rest.
 */
export function sortGroup(
  product: SortProduct,
  collection: { sizes: WheelSize[]; cars: Set<string> },
  settings: SortSettings,
): number {
  const size = hasSize(product, collection.sizes, settings);
  const car = hasAny(product.fields[settings.productMatchKey], collection.cars);
  if (size) return car ? 0 : 1;
  if (car) return 2;
  const tag = normalizeText(settings.tag);
  if (tag && toList(product.fields.tags).some((t) => normalizeText(t) === tag)) return 3;
  return 4;
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
  const keys = (raw: string | null | undefined) => new Set(toList(raw).map(equalityKey));
  const target = {
    sizes: toList(collection[settings.collectionSizeKey])
      .map(parseWheelSize)
      .filter((s): s is WheelSize => s !== null),
    cars: keys(collection[settings.collectionMatchKey]),
  };
  return products
    .map((product, index) => ({
      id: product.id,
      index,
      group: sortGroup(product, target, settings),
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
