import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { hasValidJobsSecret, jobsDisabled } from "../lib/jobs-auth.server";
import { enqueueJob } from "../lib/queue.server";
import { getRules } from "../lib/settings.server";

// Called nightly by Cloud Scheduler. Re-reads all rule collections, because metafield edits
// on a collection don't always send a collection webhook, then removes products from the
// collections that changed (the buttons in the app still go through all of them).
/** Collection sync takes a few minutes; removal needs the fresh list. */
const REMOVE_DELAY_SECONDS = 15 * 60;

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!hasValidJobsSecret(request)) return new Response("Unauthorized", { status: 401 });
  if (jobsDisabled()) return new Response("Jobs disabled", { status: 503 });
  const sessions = await db.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });
  for (const { shop } of sessions) {
    await enqueueJob(shop, "sync-collections");
    // Old job rows and removal reports otherwise fill the database disk.
    await enqueueJob(shop, "prune-history");
    if ((await getRules(shop)).removal.nightly) {
      await enqueueJob(shop, "remove-unmatched", { changedOnly: true }, { delaySeconds: REMOVE_DELAY_SECONDS });
    }
  }
  return Response.json({ shops: sessions.length });
};
