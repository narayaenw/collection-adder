import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { hasValidJobsSecret } from "../lib/jobs-auth.server";
import { enqueueJob } from "../lib/queue.server";

// Starts the history cleanup now instead of waiting for the nightly run (same secret as cron).
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!hasValidJobsSecret(request)) return new Response("Unauthorized", { status: 401 });
  const sessions = await db.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });
  const jobs = [];
  for (const { shop } of sessions) jobs.push((await enqueueJob(shop, "prune-history")).id);
  return Response.json({ jobs });
};
