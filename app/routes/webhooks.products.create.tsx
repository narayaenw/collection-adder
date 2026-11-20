import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { enqueueJob } from "../lib/queue.server";

// Product metafields are often written right after the product is created (imports, apps),
// so the evaluation waits a little before reading the product. New products are collected and
// evaluated in one batch per collection; a batch already waiting takes the new product too.
const DELAY_SECONDS = Number(process.env.PRODUCT_CREATE_DELAY_SECONDS ?? 120);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const productId = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id;
  if (productId) {
    await db.pendingProduct.upsert({
      where: { id: productId },
      create: { id: productId, shop },
      update: { createdAt: new Date() },
    });
    await enqueueJob(shop, "evaluate-pending", {}, { delaySeconds: DELAY_SECONDS, queue: "webhooks" });
  }
  return new Response();
};
