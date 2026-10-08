import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a Shopify webhook signature without touching the database. `authenticate.webhook`
 * also loads the shop's session, which during bursts of thousands of webhooks exhausts the
 * database connections.
 */
export function hasValidWebhookHmac(rawBody: string, hmacHeader: string | null): boolean {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret || !hmacHeader) return false;
  const a = Buffer.from(createHmac("sha256", secret).update(rawBody, "utf8").digest("base64"));
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}
