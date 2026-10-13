import { describe, expect, it } from "vitest";
import { innerOuter, parseSizes } from "./innerOuter";

describe("parseSizes", () => {
  it("reads lists separated by |", () => {
    expect(parseSizes("7.5 x 17 ET52 | 6.5 x 17 ET39|8 x 19 ET47")).toEqual([
      { width: 7.5, diameter: 17, et: 52 },
      { width: 6.5, diameter: 17, et: 39 },
      { width: 8, diameter: 19, et: 47 },
    ]);
  });

  it("reads J widths, decimal and negative ET", () => {
    expect(parseSizes("8Jx20 ET24|7.5 x 18 ET50.5|9 x 17 ET-12")).toEqual([
      { width: 8, diameter: 20, et: 24 },
      { width: 7.5, diameter: 18, et: 50.5 },
      { width: 9, diameter: 17, et: -12 },
    ]);
  });

  it("ignores empty values", () => {
    expect(parseSizes(null)).toEqual([]);
    expect(parseSizes("")).toEqual([]);
  });
});

describe("innerOuter", () => {
  it("takes the largest inner and outer plus tolerance", () => {
    const sizes = parseSizes("7.5 x 17 ET52|6.5 x 17 ET39|7.5 x 18 ET51|8 x 19 ET47");
    expect(innerOuter(sizes, 2)).toEqual({ inner: 150.6, outer: 56.6 });
  });

  it("matches the old 12 mm rules", () => {
    const sizes = parseSizes("7.5 x 17 ET55|7.5 x 18 ET55|7.5 x 19 ET55|8 x 19 ET55|8 x 20 ET50");
    expect(innerOuter(sizes, 12)).toEqual({ inner: 168.6, outer: 63.6 });
  });

  it("returns null without sizes", () => {
    expect(innerOuter([], 2)).toBeNull();
  });
});
