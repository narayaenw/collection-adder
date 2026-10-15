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
  /** Requested cost of requests sent but not answered yet. */
  private inFlight = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Points in the bucket now, from the last report plus what has refilled since. */
  private available(): number | undefined {
    const s = this.status;
    if (!s) return undefined;
    return Math.min(s.maximum, s.available + (s.rate * (this.now() - s.at)) / 1000);
  }

  /**
   * Milliseconds to wait before sending `query` so its requested cost fits, and the cost now
   * counted as spent (so the next caller waits its turn). Pass the cost to `record` with the
   * response. Waits nothing while nothing is known yet.
   */
  reserve(query: string): { waitMs: number; cost: number } {
    const s = this.status;
    const known = this.costs.get(query);
    const available = this.available();
    const cost = s && known !== undefined ? Math.min(known, s.maximum) : 0;
    this.inFlight += cost;
    if (!s || available === undefined || cost === 0) return { waitMs: 0, cost };
    const waitMs = available >= cost ? 0 : Math.ceil(((cost - available) / s.rate) * 1000);
    // Spent at the moment the request goes out, after the wait.
    s.available = available + (s.rate * waitMs) / 1000 - cost;
    s.at = this.now();
    return { waitMs, cost };
  }

  /**
   * Takes in the cost report of a response (successful or throttled) to a request that reserved
   * `reserved`. Shopify's figure does not yet include requests still on their way, so their
   * reservations are taken off it.
   */
  record(query: string, cost: QueryCost | undefined, reserved = 0) {
    this.inFlight = Math.max(0, this.inFlight - reserved);
    if (!cost) return;
    if (typeof cost.requestedQueryCost === "number") this.costs.set(query, cost.requestedQueryCost);
    const t = cost.throttleStatus;
    if (t && t.restoreRate > 0) {
      this.status = {
        maximum: t.maximumAvailable,
        available: t.currentlyAvailable - this.inFlight,
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
