import { describe, expect, it } from "vitest";
import { CostBucket, costOf } from "./throttle";

const report = (requested: number, available: number) => ({
  requestedQueryCost: requested,
  actualQueryCost: requested,
  throttleStatus: { maximumAvailable: 2000, currentlyAvailable: available, restoreRate: 100 },
});

describe("CostBucket", () => {
  it("does not wait before the first report", () => {
    expect(new CostBucket(() => 0).reserve("q").waitMs).toBe(0);
  });

  it("waits until the requested cost has refilled and makes the next caller queue", () => {
    let now = 0;
    const bucket = new CostBucket(() => now);
    bucket.record("q", report(1000, 500));
    expect(bucket.reserve("q").waitMs).toBe(5000); // 500 missing at 100/s
    expect(bucket.reserve("q").waitMs).toBe(10000); // the first reservation emptied it again
    now = 20000;
    expect(bucket.reserve("q").waitMs).toBe(0);
  });

  it("counts refill since the last report, up to the maximum", () => {
    let now = 0;
    const bucket = new CostBucket(() => now);
    bucket.record("q", report(300, 0));
    now = 3000;
    expect(bucket.reserve("q").waitMs).toBe(0);
    expect(bucket.reserve("unknown").waitMs).toBe(0);
  });

  it("takes requests still on their way off Shopify's report", () => {
    const now = 0;
    const bucket = new CostBucket(() => now);
    bucket.record("q", report(1000, 2000));
    const first = bucket.reserve("q");
    const second = bucket.reserve("q");
    expect(second.waitMs).toBe(0);
    // The first answer reports 1000 left, but the second request will take 1000 of it.
    bucket.record("q", report(1000, 1000), first.cost);
    expect(bucket.reserve("q").waitMs).toBe(10000);
    bucket.record("q", report(1000, 0), second.cost);
  });

  it("computes the wait for a throttled response", () => {
    expect(CostBucket.throttledWait(report(1002, 2))).toBe(10000);
    expect(CostBucket.throttledWait(undefined)).toBeUndefined();
  });
});

describe("costOf", () => {
  it("reads the cost from a response body or a client error", () => {
    const cost = report(10, 1990);
    expect(costOf({ data: {}, extensions: { cost } })).toBe(cost);
    expect(costOf({ body: { errors: [], extensions: { cost } } })).toBe(cost);
    expect(costOf(new Error("x"))).toBeUndefined();
  });
});
