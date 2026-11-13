import { describe, expect, it } from "vitest";
import { activatedProductIds } from "./activation";

const p = (id: string, status: string | null) => ({ id, fields: { status } });

describe("activatedProductIds", () => {
  it("finds products that became active since the previous pass", () => {
    const previous = new Map([
      ["a", { status: "DRAFT" }],
      ["b", { status: "ACTIVE" }],
      ["c", { status: "UNLISTED" }],
      ["d", { status: "ACTIVE" }],
      ["e", { status: "ARCHIVED" }],
    ]);
    const current = [p("a", "ACTIVE"), p("b", "ACTIVE"), p("c", "ACTIVE"), p("d", "DRAFT"), p("e", "ARCHIVED"), p("f", "ACTIVE"), p("g", "DRAFT")];
    expect(activatedProductIds(previous, current)).toEqual(["a", "c", "f"]);
  });
  it("finds nothing without a previous pass", () => {
    expect(activatedProductIds(new Map(), [p("a", "ACTIVE")])).toEqual([]);
  });
});
