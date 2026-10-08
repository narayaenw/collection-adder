import { CloudTasksClient } from "@google-cloud/tasks";
import db from "../db.server";

export type JobType =
  | "sync-collections"
  | "sync-collection"
  | "evaluate-product"
  | "evaluate-collection"
  | "evaluate-collections"
  | "evaluate-all"
  | "add-products"
  | "sort-collection"
  | "sort-all"
  | "export-plan"
  | "export-rule-groups";

let tasksClient: CloudTasksClient | undefined;

function cloudTasksConfig() {
  const { GCP_PROJECT, GCP_LOCATION, CLOUD_TASKS_QUEUE, JOBS_SECRET, SHOPIFY_APP_URL } = process.env;
  if (!GCP_PROJECT || !GCP_LOCATION || !CLOUD_TASKS_QUEUE) return null;
  if (!JOBS_SECRET || !SHOPIFY_APP_URL) {
    throw new Error("JOBS_SECRET and SHOPIFY_APP_URL are required when Cloud Tasks is configured.");
  }
  return { GCP_PROJECT, GCP_LOCATION, CLOUD_TASKS_QUEUE, JOBS_SECRET, SHOPIFY_APP_URL };
}

// Without Cloud Tasks (local development) jobs run one after another in this process.
let localChain: Promise<unknown> = Promise.resolve();

function runLocally(jobId: string, delaySeconds: number) {
  setTimeout(() => {
    localChain = localChain
      .then(async () => {
        const { runJob } = await import("./jobs.server");
        await runJob(jobId);
      })
      .catch((error) => console.error(`Job ${jobId} failed`, error));
  }, delaySeconds * 1000);
}

/**
 * Stores a job and hands it to the queue. In production Cloud Tasks calls /jobs/run, which
 * spreads work over time and retries failures; the queue's rate settings keep the app under
 * Shopify's API limits.
 */
export async function enqueueJob(
  shop: string,
  type: JobType,
  payload: Record<string, unknown> = {},
  { delaySeconds = 0 }: { delaySeconds?: number } = {},
) {
  const job = await db.job.create({ data: { shop, type, payload: payload as object } });
  const config = cloudTasksConfig();

  if (!config) {
    runLocally(job.id, delaySeconds);
    return job;
  }

  tasksClient ??= new CloudTasksClient();
  await tasksClient.createTask({
    parent: tasksClient.queuePath(config.GCP_PROJECT, config.GCP_LOCATION, config.CLOUD_TASKS_QUEUE),
    task: {
      httpRequest: {
        httpMethod: "POST",
        url: new URL("/jobs/run", config.SHOPIFY_APP_URL).toString(),
        headers: { "Content-Type": "application/json", "X-Jobs-Secret": config.JOBS_SECRET },
        body: Buffer.from(JSON.stringify({ jobId: job.id })).toString("base64"),
      },
      dispatchDeadline: { seconds: 1800 },
      ...(delaySeconds > 0
        ? { scheduleTime: { seconds: Math.floor(Date.now() / 1000) + delaySeconds } }
        : {}),
    },
  });
  return job;
}
