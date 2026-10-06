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
  collectionFilter: { key: "custom.ucel", value: "YMM_Cloudflare" },
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
};
