import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { enqueueJob } from "../lib/queue.server";
import { hasValidWebhookHmac } from "../lib/webhook-hmac.server";

// Adding products to a collection fires collections/update too, so bulk runs send thousands
// of these. Each instance remembers recently queued refreshes and skips repeats without a
// database query; one refresh reads the latest state anyway.
const RECENT_MS = 5 * 60 * 1000;
const recentlyQueued = new Map<string, number>();

function queuedRecently(key: string, now: number) {
  const at = recentlyQueued.get(key);
  if (at !== undefined && now - at < RECENT_MS) return true;
  if (recentlyQueued.size > 50_000) {
    for (const [k, t] of recentlyQueued) if (now - t >= RECENT_MS) recentlyQueued.delete(k);
  }
  recentlyQueued.set(key, now);
  return false;
}

// Keeps the local copy of rule collections current.
export const action = async ({ request }: ActionFunctionArgs) => {
  const rawBody = await request.text();
  if (!hasValidWebhookHmac(rawBody, request.headers.get("x-shopify-hmac-sha256"))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const shop = request.headers.get("x-shopify-shop-domain");
  const topic = request.headers.get("x-shopify-topic");
  if (!shop || !topic) return new Response("Bad request", { status: 400 });

  const payload = JSON.parse(rawBody) as { admin_graphql_api_id?: string; id?: number };
  const collectionId = payload.admin_graphql_api_id ?? `gid://shopify/Collection/${payload.id}`;

  if (topic === "collections/delete") {
    recentlyQueued.delete(`${shop}|${collectionId}`);
    await db.ruleCollection.deleteMany({ where: { id: collectionId, shop } });
    return new Response();
  }

  if (queuedRecently(`${shop}|${collectionId}`, Date.now())) return new Response();

  const waiting = await db.job.findFirst({
    where: {
      shop,
      type: "sync-collection",
      status: "queued",
      payload: { path: ["collectionId"], equals: collectionId },
    },
    select: { id: true },
  });
  if (!waiting) await enqueueJob(shop, "sync-collection", { collectionId });
  return new Response();
};
