import { describe, expect, it } from "vitest";
import { isReadOnlyQuery, toJsonSafe } from "./readonly-sql";

describe("isReadOnlyQuery", () => {
  it("accepts single reading queries", () => {
    expect(isReadOnlyQuery("SELECT 1")).toBe(true);
    expect(isReadOnlyQuery("  with x as (select 1) select * from x;")).toBe(true);
    expect(isReadOnlyQuery("-- note\nselect count(*) from \"Job\"")).toBe(true);
  });
  it("rejects writes and several statements", () => {
    expect(isReadOnlyQuery("delete from \"Job\"")).toBe(false);
    expect(isReadOnlyQuery("update \"Job\" set status='x'")).toBe(false);
    expect(isReadOnlyQuery("select 1; delete from \"Job\"")).toBe(false);
    expect(isReadOnlyQuery("")).toBe(false);
  });
});

describe("toJsonSafe", () => {
  it("converts bigint and dates", () => {
    const d = new Date("2026-11-01T00:00:00Z");
    expect(toJsonSafe([{ n: 5n, at: d }])).toEqual([{ n: 5, at: "2026-11-01T00:00:00.000Z" }]);
  });
});
