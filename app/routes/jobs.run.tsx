import type { ActionFunctionArgs } from "react-router";
import { hasValidJobsSecret } from "../lib/jobs-auth.server";
import { runJob } from "../lib/jobs.server";

// Called by Cloud Tasks. A non-2xx response makes Cloud Tasks retry the job.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!hasValidJobsSecret(request)) return new Response("Unauthorized", { status: 401 });
  const { jobId } = (await request.json()) as { jobId?: string };
  if (!jobId) return new Response("Missing jobId", { status: 400 });
  try {
    await runJob(jobId);
    return new Response("OK");
  } catch (error) {
    console.error(`Job ${jobId} failed`, error);
    return new Response("Job failed", { status: 500 });
  }
};
