import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { hasValidJobsSecret } from "../lib/jobs-auth.server";
import { enqueueJob } from "../lib/queue.server";

// Called nightly by Cloud Scheduler. Re-reads all rule collections, because metafield edits
// on a collection don't always send a collection webhook.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!hasValidJobsSecret(request)) return new Response("Unauthorized", { status: 401 });
  const sessions = await db.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });
  for (const { shop } of sessions) await enqueueJob(shop, "sync-collections");
  return Response.json({ shops: sessions.length });
};
