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
  /** Text put before each compared value, e.g. "Roztec:" so tag "Roztec:5x112" matches PCD "5x112". */
  valuePrefix?: string;
}

export interface RuleSet {
  /** Collections whose metafield `collectionFilter.key` equals `collectionFilter.value` are evaluated. */
  collectionFilter: { key: string; value: string };
  /** All conditions must pass (AND). List values inside one condition are OR-ed. */
  conditions: Condition[];
  /** Products from these vendors are never added. Case-insensitive. */
  excludedVendors: string[];
  carMatch: CarMatchSettings;
  removal: RemovalSettings;
  sorting: SortSettings;
}

/**
 * Products of these vendors only go to collections of their own car: the product list
 * metafield `productKey` must contain the collection's `collectionKey` value.
 */
export interface CarMatchSettings {
  /** Case-insensitive vendor names. Empty list turns the condition off. */
  vendors: string[];
  productKey: string;
  collectionKey: string;
  /** Product car values that lift the condition: such products go to every matching collection. */
  anyCarValues: string[];
}

/** Removing products that no longer match from rule collections. */
export interface RemovalSettings {
  /** Without this a removal run only reports what it would remove. */
  enabled: boolean;
  /** Run after the nightly collection sync. */
  nightly: boolean;
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
  /** Product metafield with the rim width, compared with the OE sizes' width ("8J"). */
  productWidthKey: string;
  /** Product (list) metafield with the ET values, compared with the OE sizes' ET. */
  productEtKey: string;
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
  /** Shopify product status (ACTIVE, DRAFT, ARCHIVED, UNLISTED), when it was read. */
  status?: string;
}

/** Only products in this status belong in rule collections (drafts, archived and unlisted don't). */
export const INCLUDED_PRODUCT_STATUS = "ACTIVE";

/** Whether a product may sit in rule collections; an unread status counts as allowed. */
export function hasIncludedStatus(product: { status?: string; fields?: FieldMap }): boolean {
  const status = product.status ?? product.fields?.status ?? undefined;
  return status === undefined || status === null || status === INCLUDED_PRODUCT_STATUS;
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
      productField: "tags",
      operator: "eq",
      source: { type: "collection", key: "custom.ymm_pcd" },
      valuePrefix: "Roztec:",
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
  carMatch: {
    vendors: ["Racing Line"],
    productKey: "custom.auto",
    collectionKey: "ymm.znacka",
    anyCarValues: ["Racing Line", "Aftermarket"],
  },
  removal: { enabled: false, nightly: true },
  sorting: {
    enabled: true,
    rankKey: "custom.rank",
    productSizeKey: "custom.size",
    productWidthKey: "custom.width",
    productEtKey: "custom.ett2",
    collectionSizeKey: "custom.oe_size",
    productMatchKey: "custom.auto",
    collectionMatchKey: "ymm.znacka",
    tag: "_TIP",
  },
};

/** Parent collection metafield listing its subcollections; parents are only sorted, never filled or cleaned. */
export const SUBCOLLECTION_KEY = "custom.subkolekce";
