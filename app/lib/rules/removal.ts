import { createMatcher } from "./engine";
import type { CollectionSnapshot, ProductSnapshot, RuleSet } from "./types";

/**
 * Products of `collection` that match neither it nor any of its subcollections under the
 * rules. Subcollections count because Shopify passes their products up to the parent.
 */
export function unmatchedProducts(
  collection: CollectionSnapshot,
  descendants: CollectionSnapshot[],
  products: ProductSnapshot[],
  rules: RuleSet,
): ProductSnapshot[] {
  const match = createMatcher([collection, ...descendants], rules);
  return products.filter((product) => match(product).length === 0);
}
