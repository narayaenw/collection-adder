import { describe, expect, it } from "vitest";
import { desiredOrder, reorderMoves, type SortProduct } from "./sorting";
import { DEFAULT_RULE_SET } from "./types";

const settings = DEFAULT_RULE_SET.sorting;

const product = (
  id: string,
  rank: string | null,
  cars: string[] = [],
  tags: string[] = [],
  size: string | null = null,
): SortProduct => ({
  id,
  fields: {
    "custom.rank": rank,
    "custom.size": size,
    "custom.auto": cars.length ? JSON.stringify(cars) : null,
    tags: JSON.stringify(tags),
  },
});

const car = (value: string | null) => ({ "ymm.znacka": value });

function apply(current: string[], moves: { id: string; newPosition: string }[]) {
  const order = [...current];
  for (const move of moves) {
    order.splice(order.indexOf(move.id), 1);
    order.splice(Number(move.newPosition), 0, move.id);
  }
  return order;
}

describe("desiredOrder", () => {
  it("puts the car group first, then tagged, then the rest, each by rank", () => {
    const products = [
      product("a", "5"),
      product("b", "1", ["Škoda"]),
      product("c", "9", [], ["_TIP"]),
      product("d", "7", ["škoda", "VW"]),
      product("e", "10"),
      product("f", "2", ["Škoda"], ["_TIP"]),
    ];
    expect(desiredOrder(products, car("Škoda"), settings)).toEqual(["d", "f", "b", "c", "e", "a"]);
  });

  it("puts the original size first, with the car ahead inside it", () => {
    const products = [
      product("a", "9", ["Škoda"]),
      product("b", "1", [], [], "17"),
      product("c", "5", ["Škoda"], [], "17"),
      product("d", "8", [], [], "16"),
      product("e", "3", [], ["_TIP"], "17.0"),
    ];
    expect(desiredOrder(products, { "ymm.znacka": "Škoda", "custom.original_size": "17" }, settings)).toEqual(
      ["c", "e", "b", "a", "d"],
    );
  });

  it("matches the car case-insensitively", () => {
    expect(desiredOrder([product("a", "1"), product("b", "1", ["škoda"])], car("ŠKODA"), settings)).toEqual([
      "b",
      "a",
    ]);
    expect(desiredOrder([product("a", "1"), product("b", "1", ["bmw"])], car("BMW"), settings)).toEqual([
      "b",
      "a",
    ]);
  });

  it("puts products without rank last in their group and keeps ties in current order", () => {
    const products = [product("a", null), product("b", "3"), product("c", null), product("d", "3")];
    expect(desiredOrder(products, car(null), settings)).toEqual(["b", "d", "a", "c"]);
  });

  it("ignores the tag group when no tag is set", () => {
    const products = [product("a", "1", [], ["_TIP"]), product("b", "2")];
    expect(desiredOrder(products, car(null), { ...settings, tag: "" })).toEqual(["b", "a"]);
  });
});

describe("reorderMoves", () => {
  it("needs no moves for a sorted collection", () => {
    expect(reorderMoves(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
  });

  it("produces moves that reach the desired order", () => {
    const current = ["a", "b", "c", "d", "e", "f"];
    const desired = ["d", "f", "b", "c", "e", "a"];
    const moves = reorderMoves(current, desired);
    expect(apply(current, moves)).toEqual(desired);
    expect(moves.length).toBeLessThan(current.length);
  });

  it("moves a single new product with one move", () => {
    expect(reorderMoves(["a", "b", "c", "n"], ["n", "a", "b", "c"])).toEqual([
      { id: "n", newPosition: "0" },
    ]);
  });
});
