export const OPERATORS = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in_range",
] as const;

export type Operator = (typeof OPERATORS)[number];

export const OPERATOR_LABELS: Record<Operator, string> = {
  eq: "je rovno (některé z hodnot)",
  neq: "není rovno (žádné z hodnot)",
  lt: "menší než",
  lte: "menší nebo rovno",
  gt: "větší než",
  gte: "větší nebo rovno",
  in_range: "v rozsahu (např. 16-17)",
};

/** Where the right-hand side of a condition comes from. */
export type ValueSource =
  | { type: "collection"; key: string }
  | { type: "value"; value: string };

export interface Condition {
  /** "vendor", "product_type", "tags" or a product metafield as "namespace.key". */
  productField: string;
  operator: Operator;
  source: ValueSource;
}

export interface RuleSet {
  /** Collections whose metafield `collectionFilter.key` equals `collectionFilter.value` are evaluated. */
  collectionFilter: { key: string; value: string };
  /** All conditions must pass (AND). List values inside one condition are OR-ed. */
  conditions: Condition[];
  /** Products from these vendors are never added. Case-insensitive. */
  excludedVendors: string[];
  sorting: SortSettings;
}

/**
 * Order of products inside rule collections: products with the collection's original size first
 * (those also made for its car ahead), then products made for the car, then tagged products,
 * then the rest; each group by rank from highest. Products without a
 * rank end their group, ties keep their current order.
 */
export interface SortSettings {
  enabled: boolean;
  /** Product number metafield ("namespace.key") with the rank. */
  rankKey: string;
  /** Product metafield with the wheel size, compared with `collectionSizeKey`. */
  productSizeKey: string;
  /** Collection metafield with the car's original wheel size. */
  collectionSizeKey: string;
  /** Product list metafield with the cars the wheel is designed for. */
  productMatchKey: string;
  /** Collection metafield with the collection's car, compared with `productMatchKey`. */
  collectionMatchKey: string;
  /** Products with this tag follow the car group. Empty string turns the group off. */
  tag: string;
}

/** Raw values keyed by field name, exactly as Shopify returns them (lists are JSON strings). */
export type FieldMap = Record<string, string | null | undefined>;

export interface ProductSnapshot {
  id: string;
  fields: FieldMap;
}

export interface CollectionSnapshot {
  id: string;
  title?: string;
  fields: FieldMap;
}

export const PRODUCT_BUILTIN_FIELDS = ["vendor", "product_type", "tags"];

export const DEFAULT_RULE_SET: RuleSet = {
  collectionFilter: { key: "custom.ucel", value: "YMM Cloudflare" },
  conditions: [
    {
      productField: "custom.pcd",
      operator: "eq",
      source: { type: "collection", key: "custom.ymm_pcd" },
    },
    {
      productField: "custom.size",
      operator: "in_range",
      source: { type: "collection", key: "custom.ymm_size" },
    },
    {
      productField: "custom.cb",
      operator: "gte",
      source: { type: "collection", key: "custom.ymm_cb" },
    },
    {
      productField: "custom.inner_mm",
      operator: "lt",
      source: { type: "collection", key: "custom.ymm_inner_cb" },
    },
    {
      productField: "custom.outer_mm",
      operator: "lt",
      source: { type: "collection", key: "custom.ymm_outer_cb" },
    },
  ],
  excludedVendors: ["AEZ", "Dotz", "Dezent"],
  sorting: {
    enabled: true,
    rankKey: "custom.rank",
    productSizeKey: "custom.size",
    collectionSizeKey: "custom.original_size",
    productMatchKey: "custom.auto",
    collectionMatchKey: "ymm.znacka",
    tag: "_TIP",
  },
};

/** Parent collection metafield listing its subcollections; only read by the matching-rules report. */
export const SUBCOLLECTION_KEY = "custom.subkolekce";
