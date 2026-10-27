import { createHash } from "node:crypto";
import { createMatcher, productFieldsUsed, toList } from "./engine";
import { hasIncludedStatus, SUBCOLLECTION_KEY, type CollectionSnapshot, type FieldMap, type ProductSnapshot, type RuleSet } from "./types";

/** Nightly passes that skip collections nothing has changed for. */
export type CheckKind = "clean" | "sort";

/** Product fields a pass reads: the rule fields for removal, the sort keys and tags for sorting. */
export function productKeysFor(kind: CheckKind, rules: RuleSet): string[] {
  if (kind === "clean") return productFieldsUsed(rules);
  const s = rules.sorting;
  return [...new Set([s.rankKey, s.productSizeKey, s.productWidthKey, s.productEtKey, s.productMatchKey, "tags"])];
}

export function pickFields(fields: FieldMap, keys: string[]): FieldMap {
  return Object.fromEntries(keys.map((key) => [key, fields[key] ?? null]));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Fingerprint of what a pass over one collection depends on besides its products: the
 * collection's metafields and the settings the pass uses. A different value means re-check.
 */
export function checkHash(kind: CheckKind, rules: RuleSet, collectionFields: FieldMap): string {
  const { sorting, ...ruleSettings } = rules;
  const settings = kind === "sort" ? sorting : ruleSettings;
  return createHash("sha1").update(stableJson({ settings, fields: collectionFields })).digest("hex");
}

/** Days after which a collection is checked anyway, spread over a week by collection id. */
export function recheckAfterDays(collectionId: string): number {
  const spread = createHash("sha1").update(collectionId).digest().readUInt8(0) % 7;
  return 7 + spread;
}

export function isStale(collectionId: string, checkedAt: Date, now: Date): boolean {
  return now.getTime() - checkedAt.getTime() > recheckAfterDays(collectionId) * 86_400_000;
}

/** Parent collections of each collection, from the parents' subcollection metafield. */
export function parentMap(collections: CollectionSnapshot[]): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const c of collections) {
    for (const child of toList(c.fields[SUBCOLLECTION_KEY])) {
      const list = parents.get(child);
      if (list) list.push(c.id);
      else parents.set(child, [c.id]);
    }
  }
  return parents;
}

/** The ids plus all their ancestors, since a parent shows its subcollections' products. */
export function withAncestors(ids: Iterable<string>, parents: Map<string, string[]>): Set<string> {
  const result = new Set<string>();
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    stack.push(...(parents.get(id) ?? []));
  }
  return result;
}

/**
 * Collections a pass must revisit because products changed since the last pass, judged by the
 * rules instead of by memberships (a product sits in the collections it matches):
 * - removal: collections a changed product matched before and no longer matches;
 * - sorting: collections a changed product matches before or now, since its place may move.
 * `previous` holds each product's fields as the last pass saw them.
 */
export function collectionsAffectedByProducts(
  kind: CheckKind,
  rules: RuleSet,
  collections: CollectionSnapshot[],
  previous: Map<string, FieldMap>,
  current: ProductSnapshot[],
): { collectionIds: Set<string>; changedProducts: number } {
  // A product leaving the active status has to leave its collections too.
  const keys = kind === "clean" ? [...productKeysFor(kind, rules), "status"] : productKeysFor(kind, rules);
  const ruleKeys = productFieldsUsed(rules);
  const match = createMatcher(collections, rules);
  const affected = new Set<string>();
  let changedProducts = 0;
  for (const product of current) {
    const before = previous.get(product.id);
    if (before && stableJson(pickFields(before, keys)) === stableJson(pickFields(product.fields, keys))) continue;
    changedProducts++;
    const now = new Set(
      hasIncludedStatus(product) ? match({ id: product.id, fields: pickFields(product.fields, ruleKeys) }) : [],
    );
    const was = before ? match({ id: product.id, fields: pickFields(before, ruleKeys) }) : [];
    if (kind === "clean") {
      for (const id of was) if (!now.has(id)) affected.add(id);
    } else {
      for (const id of was) affected.add(id);
      for (const id of now) affected.add(id);
    }
  }
  return { collectionIds: withAncestors(affected, parentMap(collections)), changedProducts };
}
