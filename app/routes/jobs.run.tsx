import type { ActionFunctionArgs } from "react-router";
import { hasValidJobsSecret, jobsDisabled } from "../lib/jobs-auth.server";
import db from "../db.server";
import { runJob } from "../lib/jobs.server";

// Called by Cloud Tasks. A non-2xx response makes Cloud Tasks retry the job.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!hasValidJobsSecret(request)) return new Response("Unauthorized", { status: 401 });
  const { jobId } = (await request.json()) as { jobId?: string };
  if (!jobId) return new Response("Missing jobId", { status: 400 });
  // Switched off: Cloud Tasks retries the task later instead of dropping it. Jobs started by
  // hand (and the jobs they queue) still run.
  if (jobsDisabled()) {
    const job = await db.job.findUnique({ where: { id: jobId }, select: { payload: true } });
    if ((job?.payload as { manual?: unknown } | null)?.manual !== true) {
      return new Response("Jobs disabled", { status: 503 });
    }
  }
  try {
    await runJob(jobId);
    return new Response("OK");
  } catch (error) {
    console.error(`Job ${jobId} failed`, error);
    return new Response("Job failed", { status: 500 });
  }
};
