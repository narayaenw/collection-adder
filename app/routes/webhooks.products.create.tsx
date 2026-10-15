import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueueJob } from "../lib/queue.server";

// Product metafields are often written right after the product is created (imports, apps),
// so the evaluation waits a little before reading the product.
const DELAY_SECONDS = Number(process.env.PRODUCT_CREATE_DELAY_SECONDS ?? 120);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const productId = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id;
  if (productId) {
    await enqueueJob(shop, "evaluate-product", { productId }, { delaySeconds: DELAY_SECONDS });
  }
  return new Response();
};
