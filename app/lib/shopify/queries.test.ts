import { describe, expect, it } from "vitest";
import { DEFAULT_RULE_SET } from "../rules/types";
import { parseProductRows, toGid } from "./queries";

describe("parseProductRows", () => {
  it("separates products from their collection memberships", () => {
    const rows = [
      { id: "gid://shopify/Product/1", vendor: "Brock", productType: "Alu", tags: ["a"], m0: { value: '["4x98"]' }, m1: null },
      { id: "gid://shopify/Collection/10", __parentId: "gid://shopify/Product/1" },
      { id: "gid://shopify/Collection/11", __parentId: "gid://shopify/Product/1" },
      { id: "gid://shopify/Product/2", vendor: "AEZ", productType: "", tags: [] },
    ];
    const { products, memberships } = parseProductRows(rows, DEFAULT_RULE_SET);
    expect(products.map((p) => p.id)).toEqual(["gid://shopify/Product/1", "gid://shopify/Product/2"]);
    expect(products[0].fields).toMatchObject({ vendor: "Brock", "custom.pcd": '["4x98"]', "custom.size": null, tags: '["a"]' });
    expect([...memberships.get("gid://shopify/Product/1")!]).toEqual([
      "gid://shopify/Collection/10",
      "gid://shopify/Collection/11",
    ]);
    expect(memberships.has("gid://shopify/Product/2")).toBe(false);
  });
});

describe("toGid", () => {
  it("accepts numeric ids and gids", () => {
    expect(toGid("Product", "123")).toBe("gid://shopify/Product/123");
    expect(toGid("Collection", "gid://shopify/Collection/5")).toBe("gid://shopify/Collection/5");
    expect(() => toGid("Product", "abc")).toThrow();
  });
});
