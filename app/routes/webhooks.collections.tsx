import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { hasValidWebhookHmac } from "../lib/webhook-hmac.server";

// Shopify sends collections/update for every collection a product sits in whenever the
// product changes (stock edits from bulk importers send tens of thousands a day), and when
// the app itself adds or removes products. The local copy is refreshed by the nightly full
// sync and by "Vyhodnotit kolekci", so update webhooks are acknowledged and ignored.
export const action = async ({ request }: ActionFunctionArgs) => {
  const rawBody = await request.text();
  if (!hasValidWebhookHmac(rawBody, request.headers.get("x-shopify-hmac-sha256"))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const shop = request.headers.get("x-shopify-shop-domain");
  const topic = request.headers.get("x-shopify-topic");
  if (!shop || !topic) return new Response("Bad request", { status: 400 });

  if (topic === "collections/delete") {
    const payload = JSON.parse(rawBody) as { admin_graphql_api_id?: string; id?: number };
    const collectionId = payload.admin_graphql_api_id ?? `gid://shopify/Collection/${payload.id}`;
    await db.ruleCollection.deleteMany({ where: { id: collectionId, shop } });
  }
  return new Response();
};
