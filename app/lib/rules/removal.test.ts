import { describe, expect, it } from "vitest";
import { isParentCollection } from "./engine";
import { unmatchedProducts } from "./removal";
import { DEFAULT_RULE_SET, SUBCOLLECTION_KEY, type CollectionSnapshot, type ProductSnapshot } from "./types";

const ymm = (id: string, pcd: string, car: string): CollectionSnapshot => ({
  id,
  fields: {
    "custom.ucel": "YMM Cloudflare",
    "custom.ymm_size": '["16-17"]',
    "custom.ymm_cb": "58.1",
    "custom.ymm_pcd": `["${pcd}"]`,
    "custom.ymm_inner_cb": "147.4",
    "custom.ymm_outer_cb": "65.4",
    "ymm.znacka": car,
  },
});

const wheel = (id: string, fields: Record<string, string | null> = {}): ProductSnapshot => ({
  id,
  fields: {
    vendor: "Brock",
    tags: '["Roztec:4x98"]',
    "custom.size": "17",
    "custom.cb": "58.1",
    "custom.inner_mm": "140",
    "custom.outer_mm": "60",
    ...fields,
  },
});

describe("unmatchedProducts", () => {
  const bmw = ymm("c1", "4x98", "BMW");

  it("keeps matching products and returns the rest", () => {
    const products = [wheel("p1"), wheel("p2", { tags: '["Roztec:5x112"]' }), wheel("p3", { vendor: "AEZ" })];
    expect(unmatchedProducts(bmw, products, DEFAULT_RULE_SET).map((p) => p.id)).toEqual(["p2", "p3"]);
  });

  it("removes unlisted products even when they match", () => {
    const products = [wheel("p1", {}), { ...wheel("p2"), status: "UNLISTED" }, { ...wheel("p3"), status: "ACTIVE" }];
    expect(unmatchedProducts(bmw, products, DEFAULT_RULE_SET).map((p) => p.id)).toEqual(["p2"]);
  });

  it("removes Racing Line products made for another car", () => {
    const products = [
      wheel("p1", { vendor: "Racing Line", "custom.auto": '["BMW"]' }),
      wheel("p2", { vendor: "Racing Line", "custom.auto": '["Audi"]' }),
      wheel("p3", { vendor: "Racing Line", "custom.auto": null }),
    ];
    expect(unmatchedProducts(bmw, products, DEFAULT_RULE_SET).map((p) => p.id)).toEqual(["p2", "p3"]);
  });
});

describe("isParentCollection", () => {
  it("is true only with listed subcollections", () => {
    expect(isParentCollection(ymm("p", "4x98", "BMW"))).toBe(false);
    const withChildren = ymm("p", "4x98", "BMW");
    expect(isParentCollection({ ...withChildren, fields: { ...withChildren.fields, [SUBCOLLECTION_KEY]: "[]" } })).toBe(false);
    expect(isParentCollection({ ...withChildren, fields: { ...withChildren.fields, [SUBCOLLECTION_KEY]: '["c1"]' } })).toBe(true);
  });
});
