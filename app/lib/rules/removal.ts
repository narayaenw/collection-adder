import { createMatcher } from "./engine";
import { EXCLUDED_PRODUCT_STATUS, type CollectionSnapshot, type ProductSnapshot, type RuleSet } from "./types";

/** Products of `collection` that the rules no longer put there, unlisted products included. */
export function unmatchedProducts(
  collection: CollectionSnapshot,
  products: ProductSnapshot[],
  rules: RuleSet,
): ProductSnapshot[] {
  const match = createMatcher([collection], rules);
  return products.filter(
    (product) => product.status === EXCLUDED_PRODUCT_STATUS || match(product).length === 0,
  );
}
