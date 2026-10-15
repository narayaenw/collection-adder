import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { enqueueJob } from "../lib/queue.server";

// Keeps the local copy of rule collections current.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const collectionId = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id
    ?? `gid://shopify/Collection/${(payload as { id?: number }).id}`;

  if (topic === "COLLECTIONS_DELETE") {
    await db.ruleCollection.deleteMany({ where: { id: collectionId, shop } });
  } else {
    await enqueueJob(shop, "sync-collection", { collectionId });
  }
  return new Response();
};
