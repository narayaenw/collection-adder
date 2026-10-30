import { describe, expect, it } from "vitest";
import { GROUP_JOB_SIZE, groupBySearch } from "./groups";
import { DEFAULT_RULE_SET, type CollectionSnapshot } from "./types";

function car(id: number, overrides: Record<string, string> = {}): CollectionSnapshot {
  return {
    id: `gid://shopify/Collection/${id}`,
    title: `Car ${id}`,
    fields: {
      "custom.ucel": "YMM Cloudflare",
      "custom.ymm_size": '["16-17"]',
      "custom.ymm_cb": "58.1",
      "custom.ymm_pcd": '["4x98"]',
      "custom.ymm_inner_cb": "147.4",
      "custom.ymm_outer_cb": "65.4",
      ...overrides,
    },
  };
}

describe("groupBySearch", () => {
  it("puts collections with the same parameters in one group", () => {
    const groups = groupBySearch([car(1), car(2), car(3, { "custom.ymm_cb": "60.1" })], DEFAULT_RULE_SET);
    expect(groups).toEqual([
      ["gid://shopify/Collection/1", "gid://shopify/Collection/2"],
      ["gid://shopify/Collection/3"],
    ]);
  });

  it("splits a large group into jobs of limited size", () => {
    const many = Array.from({ length: GROUP_JOB_SIZE + 5 }, (_, i) => car(i + 1));
    const groups = groupBySearch(many, DEFAULT_RULE_SET);
    expect(groups.map((g) => g.length)).toEqual([GROUP_JOB_SIZE, 5]);
  });
});
