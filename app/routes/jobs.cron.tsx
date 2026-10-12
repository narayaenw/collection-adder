import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { hasValidJobsSecret } from "../lib/jobs-auth.server";
import { enqueueJob } from "../lib/queue.server";
import { getRules } from "../lib/settings.server";

// Called nightly by Cloud Scheduler. Re-reads all rule collections, because metafield edits
// on a collection don't always send a collection webhook, then sorts them once that is done.
/** Collection sync takes a few minutes; sorting starts after it on the fresh list. */
const SORT_ALL_DELAY_SECONDS = 30 * 60;
/** Removal also needs the fresh list and runs before sorting. */
const REMOVE_DELAY_SECONDS = 15 * 60;

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!hasValidJobsSecret(request)) return new Response("Unauthorized", { status: 401 });
  const sessions = await db.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });
  for (const { shop } of sessions) {
    await enqueueJob(shop, "sync-collections");
    if ((await getRules(shop)).removal.nightly) {
      await enqueueJob(shop, "remove-unmatched", {}, { delaySeconds: REMOVE_DELAY_SECONDS });
    }
    await enqueueJob(shop, "sort-all", {}, { delaySeconds: SORT_ALL_DELAY_SECONDS });
  }
  return Response.json({ shops: sessions.length });
};
