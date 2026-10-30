import { createMatcher } from "./engine";
import { hasIncludedStatus, type CollectionSnapshot, type ProductSnapshot, type RuleSet } from "./types";

/** Products of `collection` that the rules no longer put there, products that are not active included. */
export function unmatchedProducts(
  collection: CollectionSnapshot,
  products: ProductSnapshot[],
  rules: RuleSet,
): ProductSnapshot[] {
  const match = createMatcher([collection], rules);
  return products.filter(
    (product) => !hasIncludedStatus(product) || match(product).length === 0,
  );
}
