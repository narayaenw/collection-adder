import {
  type CarMatchSettings,
  DEFAULT_RULE_SET,
  OPERATORS,
  PRODUCT_BUILTIN_FIELDS,
  SUBCOLLECTION_KEY,
  type CollectionSnapshot,
  type Condition,
  type FieldMap,
  type ProductSnapshot,
  type RemovalSettings,
  type RuleSet,
  type SortSettings,
} from "./types";

/** Splits a raw Shopify value into its items. List metafields arrive as JSON arrays. */
export function toList(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  const trimmed = String(raw).trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (item === null ? "" : String(item).trim()))
          .filter((item) => item !== "");
      }
    } catch {
      // Not JSON, fall through and treat as a single value.
    }
  }
  return [trimmed];
}

/** Normalises text for comparison: "5X114,3 " and "5x114.3" are equal. */
export function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/×/g, "x")
    .replace(/,/g, ".")
    .replace(/\s+/g, "");
}

export function toNumber(value: string): number | null {
  const normalized = value.trim().replace(/\s+/g, "").replace(",", ".");
  if (normalized === "" || !/^[-+]?\d*\.?\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parses "16-17", "16–17" or a single "18" into an inclusive range. */
export function toRange(value: string): [number, number] | null {
  const match = value
    .trim()
    .replace(/,/g, ".")
    .match(/^([-+]?\d*\.?\d+)\s*[-–—]\s*([-+]?\d*\.?\d+)$/);
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    return [Math.min(a, b), Math.max(a, b)];
  }
  const single = toNumber(value);
  return single === null ? null : [single, single];
}

/** Key under which two values compare equal: numbers by value, text normalised. */
export function equalityKey(value: string): string {
  const n = toNumber(value);
  return n !== null ? `#${n}` : normalizeText(value);
}

interface ParsedValue {
  keys: string[];
  numbers: number[];
  ranges: [number, number][];
}

function parse(raw: string | null | undefined, prefix = ""): ParsedValue {
  const items = prefix ? toList(raw).map((item) => prefix + item) : toList(raw);
  return {
    keys: items.map(equalityKey),
    numbers: items.map(toNumber).filter((n): n is number => n !== null),
    ranges: items.map(toRange).filter((r): r is [number, number] => r !== null),
  };
}

const constantCache = new Map<string, ParsedValue>();

function parsedConstant(value: string, prefix: string): ParsedValue {
  const cacheKey = `${prefix}\u0000${value}`;
  let parsed = constantCache.get(cacheKey);
  if (!parsed) {
    parsed = parse(value, prefix);
    constantCache.set(cacheKey, parsed);
  }
  return parsed;
}

function targetValue(condition: Condition, collection: FieldMap): ParsedValue {
  const prefix = condition.valuePrefix ?? "";
  return condition.source.type === "collection"
    ? parse(collection[condition.source.key], prefix)
    : parsedConstant(condition.source.value, prefix);
}

/** Values the condition compares with, prefix included. */
function targetItems(condition: Condition, collection: FieldMap): string[] {
  const items = toList(
    condition.source.type === "collection" ? collection[condition.source.key] : condition.source.value,
  );
  const prefix = condition.valuePrefix ?? "";
  return prefix ? items.map((item) => prefix + item) : items;
}

function hasCommonKey(p: string[], t: string[]): boolean {
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < t.length; j++) if (p[i] === t[j]) return true;
  }
  return false;
}

// Plain loops instead of closures: this runs for every product/collection pair.
function compareNumbers(operator: Condition["operator"], p: number[], t: number[]): boolean {
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    for (let j = 0; j < t.length; j++) {
      const b = t[j];
      if (
        (operator === "lt" && a < b) ||
        (operator === "lte" && a <= b) ||
        (operator === "gt" && a > b) ||
        (operator === "gte" && a >= b)
      ) {
        return true;
      }
    }
  }
  return false;
}

function inRange(p: number[], ranges: [number, number][]): boolean {
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < ranges.length; j++) {
      if (p[i] >= ranges[j][0] && p[i] <= ranges[j][1]) return true;
    }
  }
  return false;
}

function compare(operator: Condition["operator"], p: ParsedValue, t: ParsedValue): boolean {
  // A missing value on either side never matches, so incomplete data stays out of collections.
  if (p.keys.length === 0 || t.keys.length === 0) return false;

  switch (operator) {
    case "eq":
      return hasCommonKey(p.keys, t.keys);
    case "neq":
      return !hasCommonKey(p.keys, t.keys);
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return compareNumbers(operator, p.numbers, t.numbers);
    case "in_range":
      return inRange(p.numbers, t.ranges);
    default:
      return false;
  }
}

export function evaluateCondition(
  condition: Condition,
  product: FieldMap,
  collection: FieldMap,
): boolean {
  return compare(condition.operator, parse(product[condition.productField]), targetValue(condition, collection));
}

export function isVendorExcluded(product: ProductSnapshot, rules: RuleSet): boolean {
  const vendor = normalizeText(product.fields.vendor ?? "");
  if (!vendor) return false;
  return rules.excludedVendors.some((v) => normalizeText(v) === vendor);
}

/** Whether the product's vendor may only go to collections of its own car. */
export function needsCarMatch(product: ProductSnapshot, rules: RuleSet): boolean {
  const vendor = normalizeText(product.fields.vendor ?? "");
  if (!vendor) return false;
  return rules.carMatch.vendors.some((v) => normalizeText(v) === vendor);
}

/**
 * Cars the product is limited to, or null when it may go to any collection: its vendor is not
 * limited, or its car list holds one of the "any car" values.
 */
function limitedCars(product: ProductSnapshot, rules: RuleSet): string[] | null {
  if (!needsCarMatch(product, rules)) return null;
  const cars = parse(product.fields[rules.carMatch.productKey]).keys;
  const any = rules.carMatch.anyCarValues.map(equalityKey);
  return hasCommonKey(cars, any) ? null : cars;
}

function carMatches(product: ProductSnapshot, collection: CollectionSnapshot, rules: RuleSet): boolean {
  const cars = limitedCars(product, rules);
  return cars === null || hasCommonKey(cars, parse(collection.fields[rules.carMatch.collectionKey]).keys);
}

export function isRuleCollection(collection: CollectionSnapshot, rules: RuleSet): boolean {
  const { key, value } = rules.collectionFilter;
  return toList(collection.fields[key]).some((v) => normalizeText(v) === normalizeText(value));
}

/**
 * A parent collection lists its subcollections in the subcollection metafield. Shopify passes
 * the subcollections' products up to it, so the app never fills or cleans it (only sorts it).
 */
export function isParentCollection(collection: CollectionSnapshot): boolean {
  return toList(collection.fields[SUBCOLLECTION_KEY]).length > 0;
}

export function productMatchesCollection(
  product: ProductSnapshot,
  collection: CollectionSnapshot,
  rules: RuleSet,
): boolean {
  if (rules.conditions.length === 0) return false;
  if (isVendorExcluded(product, rules)) return false;
  if (!carMatches(product, collection, rules)) return false;
  return rules.conditions.every((c) => evaluateCondition(c, product.fields, collection.fields));
}

/** Returns ids of the collections the product belongs to under the rules. */
export function matchingCollectionIds(
  product: ProductSnapshot,
  collections: CollectionSnapshot[],
  rules: RuleSet,
): string[] {
  if (isVendorExcluded(product, rules)) return [];
  return collections
    .filter((collection) => productMatchesCollection(product, collection, rules))
    .map((collection) => collection.id);
}

/**
 * Builds a reusable matcher over many collections. Collection values are parsed once up front.
 * When a rule compares a product field for equality with a collection metafield (like PCD),
 * collections are indexed by that value so a product is only checked against collections
 * sharing it.
 */
export function createMatcher(collections: CollectionSnapshot[], rules: RuleSet) {
  const conditions = rules.conditions;
  const prepared = collections.map((collection) => ({
    id: collection.id,
    values: conditions.map((c) => targetValue(c, collection.fields)),
    cars: parse(collection.fields[rules.carMatch.collectionKey]).keys,
  }));

  const indexAt = conditions.findIndex((c) => c.operator === "eq" && c.source.type === "collection");
  const index = new Map<string, typeof prepared>();
  if (indexAt >= 0) {
    for (const collection of prepared) {
      for (const key of new Set(collection.values[indexAt].keys)) {
        const bucket = index.get(key);
        if (bucket) bucket.push(collection);
        else index.set(key, [collection]);
      }
    }
  }

  return (product: ProductSnapshot): string[] => {
    if (conditions.length === 0 || isVendorExcluded(product, rules)) return [];
    const productValues = conditions.map((c) => parse(product.fields[c.productField]));
    const cars = limitedCars(product, rules);
    if (cars && cars.length === 0) return [];

    let candidates: (typeof prepared)[number][] = prepared;
    if (indexAt >= 0) {
      const keys = productValues[indexAt].keys;
      if (keys.length === 1) {
        candidates = index.get(keys[0]) ?? [];
      } else {
        const set = new Set<(typeof prepared)[number]>();
        for (const key of keys) for (const c of index.get(key) ?? []) set.add(c);
        candidates = [...set];
      }
    }

    const matched: string[] = [];
    for (let c = 0; c < candidates.length; c++) {
      const collection = candidates[c];
      let ok = cars === null || hasCommonKey(cars, collection.cars);
      for (let i = 0; i < conditions.length && ok; i++) {
        ok = compare(conditions[i].operator, productValues[i], collection.values[i]);
      }
      if (ok) matched.push(collection.id);
    }
    return matched;
  };
}

/** Product fields the rules read: metafield keys as "namespace.key" plus built-ins like vendor. */
export function productFieldsUsed(rules: RuleSet): string[] {
  const fields = new Set<string>(["vendor"]);
  for (const c of rules.conditions) fields.add(c.productField);
  if (rules.carMatch.vendors.length > 0) fields.add(rules.carMatch.productKey);
  return [...fields];
}

export function productMetafieldKeys(rules: RuleSet): string[] {
  return productFieldsUsed(rules).filter((f) => !PRODUCT_BUILTIN_FIELDS.includes(f));
}

/**
 * Collection metafield keys the rules, the matching-rules report and the sort settings read,
 * including the filter key.
 */
export function collectionMetafieldKeys(rules: RuleSet): string[] {
  const keys = new Set<string>([rules.collectionFilter.key]);
  for (const c of rules.conditions) {
    if (c.source.type === "collection") keys.add(c.source.key);
  }
  if (rules.carMatch.vendors.length > 0) keys.add(rules.carMatch.collectionKey);
  // Kept locally so the nightly sort can tell which collections changed.
  if (rules.sorting.enabled) {
    keys.add(rules.sorting.collectionSizeKey);
    keys.add(rules.sorting.collectionMatchKey);
  }
  keys.add(SUBCOLLECTION_KEY);
  return [...keys];
}

/** Shopify search field for a product field: built-ins by name, metafields as metafields.ns.key. */
function searchField(productField: string): string {
  if (productField === "tags") return "tag";
  if (PRODUCT_BUILTIN_FIELDS.includes(productField)) return productField;
  return `metafields.${productField}`;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Spellings the rules treat as equal ("5x114,3" = "5x114.3"), since search does not. */
function spellings(value: string): string[] {
  const base = value.trim().replace(/×/g, "x");
  return [...new Set([value.trim(), base, base.replace(/,/g, "."), base.replace(/\./g, ",")])];
}

/**
 * Shopify product search query that returns at least every product matching the collection
 * under the rules (results are still checked by the rules). Conditions it cannot express are
 * left out, which only widens the result. Returns null when nothing can match because the
 * collection lacks a value a condition needs.
 */
export function productSearchQuery(collection: CollectionSnapshot, rules: RuleSet): string | null {
  const parts: string[] = [];
  for (const condition of rules.conditions) {
    const items = targetItems(condition, collection.fields);
    if (items.length === 0) return null;
    const field = searchField(condition.productField);
    const numbers = items.map(toNumber).filter((n): n is number => n !== null);

    switch (condition.operator) {
      case "eq":
        parts.push(`(${items.flatMap(spellings).map((v) => `${field}:${quote(v)}`).join(" OR ")})`);
        break;
      case "lt":
      case "lte":
        if (numbers.length === 0) return null;
        parts.push(`${field}:${condition.operator === "lt" ? "<" : "<="}${Math.max(...numbers)}`);
        break;
      case "gt":
      case "gte":
        if (numbers.length === 0) return null;
        parts.push(`${field}:${condition.operator === "gt" ? ">" : ">="}${Math.min(...numbers)}`);
        break;
      case "in_range": {
        const ranges = items.map(toRange).filter((r): r is [number, number] => r !== null);
        if (ranges.length === 0) return null;
        parts.push(`(${ranges.map(([a, b]) => `(${field}:>=${a} AND ${field}:<=${b})`).join(" OR ")})`);
        break;
      }
      default:
        // "neq" is left to the rules.
        break;
    }
  }
  for (const vendor of rules.excludedVendors) parts.push(`-vendor:${quote(vendor)}`);
  parts.push("status:active");
  return parts.join(" AND ");
}

const METAFIELD_KEY = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Validates untrusted input (settings form, stored JSON) and returns a clean rule set or errors. */
export function parseRuleSet(input: unknown): { rules?: RuleSet; errors: string[] } {
  const errors: string[] = [];
  const obj = (input ?? {}) as Record<string, unknown>;

  const filter = (obj.collectionFilter ?? {}) as Record<string, unknown>;
  const filterKey = String(filter.key ?? "").trim();
  const filterValue = String(filter.value ?? "").trim();
  if (!METAFIELD_KEY.test(filterKey)) errors.push(`Neplatné metapole pro výběr kolekcí: "${filterKey}"`);
  if (!filterValue) errors.push("Chybí hodnota pro výběr kolekcí.");

  const conditions: Condition[] = [];
  const rawConditions = Array.isArray(obj.conditions) ? obj.conditions : [];
  rawConditions.forEach((raw, index) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    const row = index + 1;
    const productField = String(c.productField ?? "").trim();
    const operator = String(c.operator ?? "") as Condition["operator"];
    const source = (c.source ?? {}) as Record<string, unknown>;
    // Only trailing spaces are trimmed: "Roztec:" stays as typed.
    const valuePrefix = String(c.valuePrefix ?? "").replace(/\s+$/, "");
    const extra = valuePrefix ? { valuePrefix } : {};

    if (!PRODUCT_BUILTIN_FIELDS.includes(productField) && !METAFIELD_KEY.test(productField)) {
      errors.push(`Řádek ${row}: neplatné pole produktu "${productField}" (např. custom.pcd nebo vendor).`);
    }
    if (!OPERATORS.includes(operator)) errors.push(`Řádek ${row}: neplatný operátor "${operator}".`);

    if (source.type === "collection") {
      const key = String(source.key ?? "").trim();
      if (!METAFIELD_KEY.test(key)) errors.push(`Řádek ${row}: neplatné metapole kolekce "${key}".`);
      conditions.push({ productField, operator, source: { type: "collection", key }, ...extra });
    } else if (source.type === "value") {
      const value = String(source.value ?? "").trim();
      if (!value) errors.push(`Řádek ${row}: chybí pevná hodnota.`);
      conditions.push({ productField, operator, source: { type: "value", value }, ...extra });
    } else {
      errors.push(`Řádek ${row}: neznámý zdroj hodnoty.`);
    }
  });
  if (conditions.length === 0) errors.push("Musí existovat alespoň jedna podmínka.");

  const sorting = parseSortSettings(obj.sorting, errors);
  const carMatch = parseCarMatch(obj.carMatch, errors);
  const removal = parseRemoval(obj.removal);

  const rawVendors = Array.isArray(obj.excludedVendors) ? obj.excludedVendors : [];
  const excludedVendors = [
    ...new Set(rawVendors.map((v) => String(v).trim()).filter((v) => v !== "")),
  ];

  if (errors.length > 0) return { errors };
  return {
    rules: {
      collectionFilter: { key: filterKey, value: filterValue },
      conditions,
      excludedVendors,
      carMatch,
      removal,
      sorting,
    },
    errors,
  };
}

function parseSortSettings(input: unknown, errors: string[]): SortSettings {
  // Rules saved before sorting existed get the defaults.
  if (input === undefined || input === null) return { ...DEFAULT_RULE_SET.sorting };
  const obj: Record<string, unknown> = { ...DEFAULT_RULE_SET.sorting, ...(input as object) };
  // The collection's original size moved to the OE size list (Adam, 2026-10-13).
  if (obj.collectionSizeKey === "custom.original_size") obj.collectionSizeKey = DEFAULT_RULE_SET.sorting.collectionSizeKey;
  const key = (name: Exclude<keyof SortSettings, "enabled" | "tag">, label: string) => {
    const value = String(obj[name] ?? "").trim();
    if (!METAFIELD_KEY.test(value)) errors.push(`Neplatné metapole pro řazení (${label}): "${value}"`);
    return value;
  };
  return {
    enabled: obj.enabled === true || obj.enabled === "true" || obj.enabled === "on",
    rankKey: key("rankKey", "rank"),
    productSizeKey: key("productSizeKey", "rozměr na produktu"),
    productWidthKey: key("productWidthKey", "šířka na produktu"),
    productEtKey: key("productEtKey", "ET na produktu"),
    collectionSizeKey: key("collectionSizeKey", "rozměr na kolekci"),
    productMatchKey: key("productMatchKey", "auto na produktu"),
    collectionMatchKey: key("collectionMatchKey", "auto na kolekci"),
    tag: String(obj.tag ?? "").trim(),
  };
}

const isOn = (value: unknown) => value === true || value === "true" || value === "on";

function parseCarMatch(input: unknown, errors: string[]): CarMatchSettings {
  // Rules saved before this setting existed get the defaults.
  if (input === undefined || input === null) return structuredClone(DEFAULT_RULE_SET.carMatch);
  const obj = { ...DEFAULT_RULE_SET.carMatch, ...(input as object) } as Record<string, unknown>;
  const key = (name: "productKey" | "collectionKey", label: string) => {
    const value = String(obj[name] ?? "").trim();
    if (!METAFIELD_KEY.test(value)) errors.push(`Neplatné metapole pro shodu auta (${label}): "${value}"`);
    return value;
  };
  const list = (raw: unknown) =>
    [...new Set((Array.isArray(raw) ? raw : []).map((v) => String(v).trim()).filter((v) => v !== ""))];
  return {
    vendors: list(obj.vendors),
    anyCarValues: list(obj.anyCarValues),
    productKey: key("productKey", "auta na produktu"),
    collectionKey: key("collectionKey", "auto kolekce"),
  };
}

function parseRemoval(input: unknown): RemovalSettings {
  if (input === undefined || input === null) return { ...DEFAULT_RULE_SET.removal };
  const obj = input as Record<string, unknown>;
  return { enabled: isOn(obj.enabled), nightly: isOn(obj.nightly) };
}
