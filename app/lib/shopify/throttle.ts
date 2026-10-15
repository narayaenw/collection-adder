/** Shopify's query cost report (`extensions.cost` of an Admin GraphQL response). */
export interface QueryCost {
  requestedQueryCost?: number;
  actualQueryCost?: number | null;
  throttleStatus?: {
    maximumAvailable: number;
    currentlyAvailable: number;
    restoreRate: number;
  };
}

/** Reads `extensions.cost` from a response body or a thrown GraphQL client error. */
export function costOf(source: unknown): QueryCost | undefined {
  const s = source as {
    extensions?: { cost?: QueryCost };
    body?: { extensions?: { cost?: QueryCost } };
  } | null;
  return s?.extensions?.cost ?? s?.body?.extensions?.cost;
}

/**
 * Local estimate of the shop's query cost bucket. Shopify charges a query's requested cost
 * up front and throttles it when the bucket holds less, so requests wait here until the bucket
 * has refilled enough instead of being sent, throttled and retried blindly. Parallel jobs in one
 * instance share the estimate, so they take turns rather than draining the bucket together.
 */
export class CostBucket {
  private status?: { maximum: number; available: number; rate: number; at: number };
  private readonly costs = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Points in the bucket now, from the last report plus what has refilled since. */
  private available(): number | undefined {
    const s = this.status;
    if (!s) return undefined;
    return Math.min(s.maximum, s.available + (s.rate * (this.now() - s.at)) / 1000);
  }

  /**
   * Milliseconds to wait before sending `query` so its requested cost fits, then counts the
   * cost as spent so the next caller waits its turn. 0 while nothing is known yet.
   */
  reserve(query: string): number {
    const s = this.status;
    const cost = this.costs.get(query);
    const available = this.available();
    if (!s || cost === undefined || available === undefined) return 0;
    const needed = Math.min(cost, s.maximum);
    const waitMs = available >= needed ? 0 : Math.ceil(((needed - available) / s.rate) * 1000);
    // Spent at the moment the request goes out, after the wait.
    s.available = available + (s.rate * waitMs) / 1000 - needed;
    s.at = this.now();
    return waitMs;
  }

  /** Takes in the cost report of a response (successful or throttled). */
  record(query: string, cost: QueryCost | undefined) {
    if (!cost) return;
    if (typeof cost.requestedQueryCost === "number") this.costs.set(query, cost.requestedQueryCost);
    const t = cost.throttleStatus;
    if (t && t.restoreRate > 0) {
      this.status = {
        maximum: t.maximumAvailable,
        available: t.currentlyAvailable,
        rate: t.restoreRate,
        at: this.now(),
      };
    }
  }

  /** Milliseconds until a throttled query's requested cost has refilled, if Shopify reported it. */
  static throttledWait(cost: QueryCost | undefined): number | undefined {
    const t = cost?.throttleStatus;
    if (!t || !(t.restoreRate > 0) || typeof cost?.requestedQueryCost !== "number") return undefined;
    const needed = Math.min(cost.requestedQueryCost, t.maximumAvailable) - t.currentlyAvailable;
    return Math.max(0, Math.ceil((needed / t.restoreRate) * 1000));
  }
}
