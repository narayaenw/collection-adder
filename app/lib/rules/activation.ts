import { INCLUDED_PRODUCT_STATUS, type FieldMap, type ProductSnapshot } from "./types";

/**
 * Products active now that were not active at the previous nightly pass: activated drafts or
 * unlisted products, and products created since then that were activated later (a product
 * created as active is already evaluated by the products/create webhook; evaluating it again
 * only finds nothing to add). Without a previous pass nothing counts as activated.
 */
export function activatedProductIds(previous: Map<string, FieldMap>, current: ProductSnapshot[]): string[] {
  if (previous.size === 0) return [];
  const ids: string[] = [];
  for (const product of current) {
    if (product.fields.status !== INCLUDED_PRODUCT_STATUS) continue;
    if (previous.get(product.id)?.status === INCLUDED_PRODUCT_STATUS) continue;
    ids.push(product.id);
  }
  return ids;
}
