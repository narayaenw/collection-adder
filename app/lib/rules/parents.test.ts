import { describe, expect, it } from "vitest";
import { leafDescendants, parentDiff } from "./parents";
import { SUBCOLLECTION_KEY, type CollectionSnapshot } from "./types";

const c = (id: string, children: string[] = []): CollectionSnapshot => ({
  id,
  fields: children.length ? { [SUBCOLLECTION_KEY]: JSON.stringify(children) } : {},
});

describe("leafDescendants", () => {
  it("returns leaves through nested parents", () => {
    const all = [c("brand", ["gen1", "gen2"]), c("gen1", ["m1", "m2"]), c("gen2", ["m3"]), c("m1"), c("m2"), c("m3")];
    expect(leafDescendants("brand", all)?.sort()).toEqual(["m1", "m2", "m3"]);
    expect(leafDescendants("gen1", all)?.sort()).toEqual(["m1", "m2"]);
  });

  it("gives up on an unknown subcollection", () => {
    expect(leafDescendants("p", [c("p", ["m1", "x"]), c("m1")])).toBeNull();
  });

  it("survives cycles", () => {
    expect(leafDescendants("a", [c("a", ["b"]), c("b", ["a", "m"]), c("m")])).toEqual(["m"]);
  });
});

describe("parentDiff", () => {
  it("adds missing and removes extra products", () => {
    expect(parentDiff(["x", "y"], [["y", "z"], ["z"]])).toEqual({ add: ["z"], remove: ["x"] });
  });

  it("empties a parent whose leaves are empty", () => {
    expect(parentDiff(["x"], [[], []])).toEqual({ add: [], remove: ["x"] });
  });
});
