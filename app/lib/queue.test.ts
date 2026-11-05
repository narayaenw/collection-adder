import { describe, expect, it } from "vitest";
import { dedupKeyFor } from "./queue.server";

describe("dedupKeyFor", () => {
  it("ignores run, queue and the manual flag but not the work itself", () => {
    const key = dedupKeyFor("evaluate-product", { productId: "p1" });
    expect(dedupKeyFor("evaluate-product", { productId: "p1", manual: true, queue: "manual" })).toBe(key);
    expect(dedupKeyFor("evaluate-product", { productId: "p2" })).not.toBe(key);
    expect(dedupKeyFor("sync-collection", { productId: "p1" })).not.toBe(key);
    const group = { collectionIds: ["a", "b"], add: true, runId: "r1" };
    expect(dedupKeyFor("evaluate-group", { ...group, runId: "r2" })).toBe(dedupKeyFor("evaluate-group", group));
    expect(dedupKeyFor("evaluate-group", { ...group, add: false })).not.toBe(dedupKeyFor("evaluate-group", group));
  });
});
