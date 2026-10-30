import { normalizeText, toList } from "./engine";
import { SUBCOLLECTION_KEY, type CollectionSnapshot, type RuleSet } from "./types";

export interface RuleGroupRow {
  parentId: string;
  parentTitle: string;
  /** Direct subcollections of the parent that are rule collections. */
  childCount: number;
  /** Distinct rule value combinations among those subcollections. */
  groupCount: number;
  /** Raw collection values of this combination, one per collection metafield the rules read. */
  values: string[];
  /** Subcollections sharing this combination. */
  count: number;
}

/** Collection metafields the rule conditions read, in condition order. */
export function ruleValueKeys(rules: RuleSet): string[] {
  const keys: string[] = [];
  for (const c of rules.conditions) {
    if (c.source.type === "collection" && !keys.includes(c.source.key)) keys.push(c.source.key);
  }
  return keys;
}

/**
 * For every parent collection (subcollection metafield), groups its direct subcollections by
 * the values the rules read, so subcollections with the same rules fall into one row.
 * Values compare normalised ("5X112" = "5x112", list order ignored).
 */
export function ruleGroups(collections: CollectionSnapshot[], rules: RuleSet): RuleGroupRow[] {
  const keys = ruleValueKeys(rules);
  const byId = new Map(collections.map((c) => [c.id, c]));
  const rows: RuleGroupRow[] = [];

  for (const parent of collections) {
    const children = [...new Set(toList(parent.fields[SUBCOLLECTION_KEY]))]
      .filter((id) => id !== parent.id)
      .map((id) => byId.get(id))
      .filter((c): c is CollectionSnapshot => c !== undefined);
    if (children.length === 0) continue;

    const groups = new Map<string, { values: string[]; count: number }>();
    for (const child of children) {
      const values = keys.map((k) => toList(child.fields[k]).join(", "));
      const signature = keys
        .map((k) => toList(child.fields[k]).map(normalizeText).sort().join("|"))
        .join("#");
      const group = groups.get(signature);
      if (group) group.count++;
      else groups.set(signature, { values, count: 1 });
    }

    for (const group of [...groups.values()].sort((a, b) => b.count - a.count)) {
      rows.push({
        parentId: parent.id,
        parentTitle: parent.title ?? "",
        childCount: children.length,
        groupCount: groups.size,
        values: group.values,
        count: group.count,
      });
    }
  }
  return rows;
}
