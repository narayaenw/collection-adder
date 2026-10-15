import { describe, expect, it } from "vitest";
import { checkHash, collectionsAffectedByProducts, isStale, recheckAfterDays, withAncestors, parentMap } from "./changes";
import { DEFAULT_RULE_SET, SUBCOLLECTION_KEY, type CollectionSnapshot, type FieldMap } from "./types";

const ymm = (id: string, pcd: string, extra: FieldMap = {}): CollectionSnapshot => ({
  id,
  fields: {
    "custom.ucel": "YMM Cloudflare",
    "custom.ymm_size": '["16-17"]',
    "custom.ymm_cb": "58.1",
    "custom.ymm_pcd": `["${pcd}"]`,
    "custom.ymm_inner_cb": "147.4",
    "custom.ymm_outer_cb": "65.4",
    ...extra,
  },
});

const wheel = (fields: FieldMap = {}): FieldMap => ({
  vendor: "Brock",
  tags: "[]",
  "custom.pcd": '["4x98"]',
  "custom.size": "17",
  "custom.cb": "58.1",
  "custom.inner_mm": "140",
  "custom.outer_mm": "60",
  "custom.rank": "5",
  ...fields,
});

const a = ymm("a", "4x98");
const b = ymm("b", "5x112");
const parent = ymm("p", "4x98", { [SUBCOLLECTION_KEY]: '["a"]' });
const collections = [a, b, parent];

describe("collectionsAffectedByProducts", () => {
  it("skips products whose fields did not change", () => {
    const previous = new Map([["x", wheel()]]);
    const result = collectionsAffectedByProducts("clean", DEFAULT_RULE_SET, collections, previous, [
      { id: "x", fields: wheel() },
    ]);
    expect(result.changedProducts).toBe(0);
    expect([...result.collectionIds]).toEqual([]);
  });

  it("removal revisits collections the product stopped matching, with their parents", () => {
    const previous = new Map([["x", wheel()]]);
    const result = collectionsAffectedByProducts("clean", DEFAULT_RULE_SET, collections, previous, [
      { id: "x", fields: wheel({ "custom.pcd": '["5x112"]' }) },
    ]);
    expect(result.changedProducts).toBe(1);
    expect([...result.collectionIds].sort()).toEqual(["a", "p"]);
  });

  it("sorting revisits collections matched before or now when a sort field changes", () => {
    const previous = new Map([["x", wheel()]]);
    const rankOnly = collectionsAffectedByProducts("sort", DEFAULT_RULE_SET, collections, previous, [
      { id: "x", fields: wheel({ "custom.rank": "9" }) },
    ]);
    expect([...rankOnly.collectionIds].sort()).toEqual(["a", "p"]);
    const ruleOnly = collectionsAffectedByProducts("sort", DEFAULT_RULE_SET, collections, previous, [
      { id: "x", fields: wheel({ "custom.cb": "57.1" }) },
    ]);
    expect(ruleOnly.changedProducts).toBe(0);
  });
});

describe("checkHash", () => {
  it("changes with the collection fields and with the settings of its pass only", () => {
    const base = checkHash("clean", DEFAULT_RULE_SET, a.fields);
    expect(checkHash("clean", DEFAULT_RULE_SET, { ...a.fields })).toBe(base);
    expect(checkHash("clean", DEFAULT_RULE_SET, { ...a.fields, "custom.ymm_cb": "60" })).not.toBe(base);
    const otherSorting = { ...DEFAULT_RULE_SET, sorting: { ...DEFAULT_RULE_SET.sorting, tag: "X" } };
    expect(checkHash("clean", otherSorting, a.fields)).toBe(base);
    expect(checkHash("sort", otherSorting, a.fields)).not.toBe(checkHash("sort", DEFAULT_RULE_SET, a.fields));
  });
});

describe("staleness and ancestors", () => {
  it("rechecks after 7 to 13 days", () => {
    const days = recheckAfterDays("gid://shopify/Collection/1");
    expect(days).toBeGreaterThanOrEqual(7);
    expect(days).toBeLessThan(14);
    const now = new Date("2026-10-20T00:00:00Z");
    expect(isStale("gid://shopify/Collection/1", new Date("2026-10-19T00:00:00Z"), now)).toBe(false);
    expect(isStale("gid://shopify/Collection/1", new Date("2026-10-01T00:00:00Z"), now)).toBe(true);
  });

  it("adds parents transitively", () => {
    const top = ymm("t", "4x98", { [SUBCOLLECTION_KEY]: '["p"]' });
    expect([...withAncestors(["a"], parentMap([...collections, top]))].sort()).toEqual(["a", "p", "t"]);
  });
});
