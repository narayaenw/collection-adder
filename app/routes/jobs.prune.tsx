import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { hasValidJobsSecret } from "../lib/jobs-auth.server";
import { enqueueJob } from "../lib/queue.server";

// Starts the history cleanup now instead of waiting for the nightly run (same secret as cron).
// With {"all": true} it empties the removal log and the job history right away, but only while
// no job is queued or running.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!hasValidJobsSecret(request)) return new Response("Unauthorized", { status: 401 });
  const { all } = (await request.json().catch(() => ({}))) as { all?: boolean };

  if (all === true) {
    const active = await db.job.count({ where: { status: { in: ["queued", "running"] } } });
    if (active > 0) return Response.json({ error: `${active} jobs are queued or running.` }, { status: 409 });
    const removalItems = await db.removalItem.count();
    await db.$executeRawUnsafe('TRUNCATE TABLE "RemovalItem"');
    const { count: jobs } = await db.job.deleteMany({ where: { status: { notIn: ["queued", "running"] } } });
    return Response.json({ removalItems, jobs });
  }

  const sessions = await db.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });
  const jobs = [];
  for (const { shop } of sessions) jobs.push((await enqueueJob(shop, "prune-history")).id);
  return Response.json({ jobs });
};
