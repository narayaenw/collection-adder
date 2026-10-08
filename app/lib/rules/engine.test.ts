import { describe, expect, it } from "vitest";
import {
  collectionMetafieldKeys,
  createMatcher,
  evaluateCondition,
  isRuleCollection,
  matchingCollectionIds,
  parseRuleSet,
  productMetafieldKeys,
  productSearchQuery,
  toList,
  toRange,
} from "./engine";
import { DEFAULT_RULE_SET, type CollectionSnapshot, type ProductSnapshot } from "./types";

// Values taken from the Abarth 595C collection export.
const abarth: CollectionSnapshot = {
  id: "gid://shopify/Collection/724502380812",
  title: "ABARTH 595C 312 [2008-2016] 1.4T Abarth I4 103 kW",
  fields: {
    "custom.ucel": "YMM Cloudflare",
    "custom.ymm_size": '["16-17"]',
    "custom.ymm_cb": "58.1",
    "custom.ymm_pcd": '["4x98"]',
    "custom.ymm_inner_cb": "147.4",
    "custom.ymm_outer_cb": "65.4",
  },
};

function wheel(overrides: Record<string, string | null> = {}): ProductSnapshot {
  return {
    id: "gid://shopify/Product/1",
    fields: {
      vendor: "Brock",
      "custom.pcd": '["4x98"]',
      "custom.size": "17",
      "custom.cb": "58.1",
      "custom.inner_mm": "140",
      "custom.outer_mm": "60",
      ...overrides,
    },
  };
}

describe("value parsing", () => {
  it("reads JSON lists and scalars", () => {
    expect(toList('["4x98","5x100"]')).toEqual(["4x98", "5x100"]);
    expect(toList("58.1")).toEqual(["58.1"]);
    expect(toList("")).toEqual([]);
    expect(toList(null)).toEqual([]);
  });

  it("parses ranges", () => {
    expect(toRange("16-17")).toEqual([16, 17]);
    expect(toRange("17–16")).toEqual([16, 17]);
    expect(toRange("18")).toEqual([18, 18]);
    expect(toRange("abc")).toBeNull();
  });
});

describe("default rules on the Abarth collection", () => {
  const rules = DEFAULT_RULE_SET;

  it("adds a fitting wheel", () => {
    expect(matchingCollectionIds(wheel(), [abarth], rules)).toEqual([abarth.id]);
  });

  it("matches PCD regardless of case and decimal comma", () => {
    const c = { ...abarth, fields: { ...abarth.fields, "custom.ymm_pcd": '["5x114.3"]' } };
    expect(matchingCollectionIds(wheel({ "custom.pcd": "5X114,3" }), [c], rules)).toEqual([c.id]);
  });

  it("matches any PCD from a list", () => {
    const c = { ...abarth, fields: { ...abarth.fields, "custom.ymm_pcd": '["5x100","4x98"]' } };
    expect(matchingCollectionIds(wheel(), [c], rules)).toEqual([c.id]);
  });

  it("rejects wrong PCD", () => {
    expect(matchingCollectionIds(wheel({ "custom.pcd": '["5x112"]' }), [abarth], rules)).toEqual([]);
  });

  it("treats size range as inclusive", () => {
    expect(matchingCollectionIds(wheel({ "custom.size": "16" }), [abarth], rules)).toHaveLength(1);
    expect(matchingCollectionIds(wheel({ "custom.size": "15" }), [abarth], rules)).toHaveLength(0);
    expect(matchingCollectionIds(wheel({ "custom.size": "18" }), [abarth], rules)).toHaveLength(0);
  });

  it("needs centre bore at least the car's", () => {
    expect(matchingCollectionIds(wheel({ "custom.cb": "72.6" }), [abarth], rules)).toHaveLength(1);
    expect(matchingCollectionIds(wheel({ "custom.cb": "57.1" }), [abarth], rules)).toHaveLength(0);
  });

  it("needs inner and outer dimensions strictly below the car's limits", () => {
    expect(matchingCollectionIds(wheel({ "custom.inner_mm": "147.4" }), [abarth], rules)).toHaveLength(0);
    expect(matchingCollectionIds(wheel({ "custom.outer_mm": "65.4" }), [abarth], rules)).toHaveLength(0);
  });

  it("skips excluded vendors case-insensitively", () => {
    expect(matchingCollectionIds(wheel({ vendor: "dotz" }), [abarth], rules)).toEqual([]);
  });

  it("never matches when a value is missing", () => {
    expect(matchingCollectionIds(wheel({ "custom.cb": null }), [abarth], rules)).toEqual([]);
    const c = { ...abarth, fields: { ...abarth.fields, "custom.ymm_outer_cb": null } };
    expect(matchingCollectionIds(wheel(), [c], rules)).toEqual([]);
  });

  it("recognises YMM collections by custom.ucel", () => {
    expect(isRuleCollection(abarth, rules)).toBe(true);
    expect(isRuleCollection({ ...abarth, fields: { "custom.ucel": "Jiny" } }, rules)).toBe(false);
  });

  it("lists the metafields it needs", () => {
    expect(productMetafieldKeys(rules)).toEqual([
      "custom.pcd",
      "custom.size",
      "custom.cb",
      "custom.inner_mm",
      "custom.outer_mm",
    ]);
    expect(collectionMetafieldKeys(rules)).toContain("custom.ucel");
    expect(collectionMetafieldKeys(rules)).toContain("custom.ymm_outer_cb");
  });
});

describe("conditions with fixed values", () => {
  it("compares against a constant", () => {
    expect(
      evaluateCondition(
        { productField: "custom.size", operator: "gt", source: { type: "value", value: "19" } },
        { "custom.size": "20" },
        {},
      ),
    ).toBe(true);
  });

  it("neq rejects any equal value", () => {
    expect(
      evaluateCondition(
        { productField: "vendor", operator: "neq", source: { type: "value", value: '["AEZ","Dotz"]' } },
        { vendor: "AEZ" },
        {},
      ),
    ).toBe(false);
  });
});

describe("parseRuleSet", () => {
  it("accepts the default rules", () => {
    expect(parseRuleSet(DEFAULT_RULE_SET)).toEqual({ rules: DEFAULT_RULE_SET, errors: [] });
  });

  it("reports bad input", () => {
    const { rules, errors } = parseRuleSet({
      collectionFilter: { key: "ucel", value: "" },
      conditions: [{ productField: "bad field", operator: "nope", source: { type: "collection", key: "" } }],
    });
    expect(rules).toBeUndefined();
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe("createMatcher", () => {
  const rules = DEFAULT_RULE_SET;

  it("gives the same result as checking every collection", () => {
    const other = { ...abarth, id: "gid://shopify/Collection/2", fields: { ...abarth.fields, "custom.ymm_pcd": '["5x112"]' } };
    const third = { ...abarth, id: "gid://shopify/Collection/3", fields: { ...abarth.fields, "custom.ymm_pcd": '["4X98","5x112"]' } };
    const all = [abarth, other, third];
    const match = createMatcher(all, rules);
    for (const product of [wheel(), wheel({ "custom.pcd": "5x112" }), wheel({ vendor: "AEZ" })]) {
      expect(match(product).sort()).toEqual(matchingCollectionIds(product, all, rules).sort());
    }
  });

  it("handles 17k collections and 2k products in reasonable time", () => {
    const pcds = ["4x98", "4x100", "4x108", "5x100", "5x108", "5x112", "5x114.3", "5x120", "5x130", "6x139.7"];
    const collections: CollectionSnapshot[] = Array.from({ length: 17000 }, (_, i) => ({
      id: `gid://shopify/Collection/${i}`,
      fields: {
        ...abarth.fields,
        "custom.ymm_pcd": JSON.stringify([pcds[i % pcds.length]]),
        "custom.ymm_size": JSON.stringify([`${15 + (i % 5)}-${17 + (i % 5)}`]),
        "custom.ymm_cb": String(54 + (i % 20)),
      },
    }));
    const products: ProductSnapshot[] = Array.from({ length: 2000 }, (_, i) =>
      wheel({ "custom.pcd": pcds[i % pcds.length], "custom.size": String(15 + (i % 8)), "custom.cb": String(56 + (i % 20)) }),
    );
    const started = Date.now();
    const match = createMatcher(collections, rules);
    let total = 0;
    for (const product of products) total += match(product).length;
    expect(total).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(10000);
  }, 30000);
});

describe("productSearchQuery", () => {
  const rules = DEFAULT_RULE_SET;
  const gle = {
    id: "gid://shopify/Collection/724970733836",
    fields: {
      "custom.ymm_pcd": '["5x112"]',
      "custom.ymm_size": '["21-22"]',
      "custom.ymm_cb": "66.5",
      "custom.ymm_inner_cb": "216.6",
      "custom.ymm_outer_cb": "125.5",
    },
  };

  it("expresses every condition and the vendor exclusions", () => {
    expect(productSearchQuery(gle, rules)).toBe(
      '(metafields.custom.pcd:"5x112") AND ' +
        "((metafields.custom.size:>=21 AND metafields.custom.size:<=22)) AND " +
        "metafields.custom.cb:>=66.5 AND metafields.custom.inner_mm:<216.6 AND " +
        'metafields.custom.outer_mm:<125.5 AND -vendor:"AEZ" AND -vendor:"Dotz" AND -vendor:"Dezent"',
    );
  });

  it("searches every spelling the rules treat as equal", () => {
    const q = productSearchQuery({ ...gle, fields: { ...gle.fields, "custom.ymm_pcd": '["5x114,3"]' } }, rules);
    expect(q).toContain('metafields.custom.pcd:"5x114,3" OR metafields.custom.pcd:"5x114.3"');
  });

  it("returns null when the collection lacks a value", () => {
    expect(productSearchQuery({ ...gle, fields: { ...gle.fields, "custom.ymm_cb": null } }, rules)).toBeNull();
  });
});
