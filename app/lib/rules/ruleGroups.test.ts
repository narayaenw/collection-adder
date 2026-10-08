import { describe, expect, it } from "vitest";
import { ruleGroups } from "./ruleGroups";
import { DEFAULT_RULE_SET, type CollectionSnapshot } from "./types";

const car = (id: string, pcd: string, size = "16-17"): CollectionSnapshot => ({
  id,
  title: id,
  fields: {
    "custom.ymm_pcd": pcd,
    "custom.ymm_size": size,
    "custom.ymm_cb": "57.1",
    "custom.ymm_inner_cb": "60",
    "custom.ymm_outer_cb": "70",
  },
});

describe("ruleGroups", () => {
  it("groups direct subcollections with the same rule values", () => {
    const parent: CollectionSnapshot = {
      id: "P",
      title: "Golf",
      fields: { "custom.subkolekce": JSON.stringify(["A", "B", "C", "missing", "P"]) },
    };
    const rows = ruleGroups(
      [parent, car("A", '["5x112"]'), car("B", '["5X112"]'), car("C", '["5x100"]')],
      DEFAULT_RULE_SET,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ parentId: "P", childCount: 3, groupCount: 2, count: 2 });
    expect(rows[0].values[0]).toBe("5x112");
    expect(rows[1]).toMatchObject({ count: 1, values: ["5x100", "16-17", "57.1", "60", "70"] });
  });

  it("skips collections without subcollections", () => {
    expect(ruleGroups([car("A", "5x112")], DEFAULT_RULE_SET)).toEqual([]);
  });
});
