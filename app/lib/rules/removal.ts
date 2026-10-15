import { createMatcher } from "./engine";
import type { CollectionSnapshot, ProductSnapshot, RuleSet } from "./types";

/** Products of `collection` that the rules no longer put there. */
export function unmatchedProducts(
  collection: CollectionSnapshot,
  products: ProductSnapshot[],
  rules: RuleSet,
): ProductSnapshot[] {
  const match = createMatcher([collection], rules);
  return products.filter((product) => match(product).length === 0);
}
