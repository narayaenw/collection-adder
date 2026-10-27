import { AsyncLocalStorage } from "node:async_hooks";
import { CloudTasksClient } from "@google-cloud/tasks";
import db from "../db.server";

export type JobType =
  | "sync-collections"
  | "sync-collection"
  | "evaluate-product"
  | "evaluate-collection"
  | "evaluate-collections"
  | "evaluate-group"
  | "evaluate-all"
  | "add-products"
  | "sort-collection"
  | "sort-all"
  | "export-plan"
  | "export-rule-groups"
  | "remove-unmatched"
  | "clean-collection"
  | "remove-smart-rules";

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

/** Raised inside a job whose row was cancelled by a queue reset, to stop it fanning out further. */
export class JobCancelledError extends Error {}

const currentJob = new AsyncLocalStorage<{ id: string; checkedAt: number; manual: boolean }>();
const CANCEL_CHECK_MS = 5000;

/**
 * Runs a job's handler so that jobs it enqueues can notice it was cancelled, and so that jobs
 * started by hand pass that on to the jobs they queue.
 */
export function runInJob<T>(jobId: string, fn: () => Promise<T>, manual = false): Promise<T> {
  return currentJob.run({ id: jobId, checkedAt: Date.now(), manual }, fn);
}

async function assertCurrentJobActive() {
  const job = currentJob.getStore();
  if (!job || Date.now() - job.checkedAt < CANCEL_CHECK_MS) return;
  job.checkedAt = Date.now();
  const row = await db.job.findUnique({ where: { id: job.id }, select: { status: true } });
  if (row?.status === "cancelled") throw new JobCancelledError(`Job ${job.id} was cancelled`);
}

/**
 * Stores a job and hands it to the queue. In production Cloud Tasks calls /jobs/run, which
 * spreads work over time and retries failures; the queue's rate settings keep the app under
 * Shopify's API limits. Jobs started by hand (`manual`, or queued by such a job) are marked so
 * they run even with JOBS_DISABLED, and go to CLOUD_TASKS_MANUAL_QUEUE when it is set, so pausing
 * the main queue does not hold them up.
 */
export async function enqueueJob(
  shop: string,
  type: JobType,
  payload: Record<string, unknown> = {},
  { delaySeconds = 0, manual }: { delaySeconds?: number; manual?: boolean } = {},
) {
  await assertCurrentJobActive();
  const isManual = manual ?? currentJob.getStore()?.manual ?? false;
  const data = isManual ? { ...payload, manual: true } : payload;
  const job = await db.job.create({ data: { shop, type, payload: data as object } });
  const config = cloudTasksConfig();

  if (!config) {
    runLocally(job.id, delaySeconds);
    return job;
  }

  tasksClient ??= new CloudTasksClient();
  await tasksClient.createTask({
    parent: tasksClient.queuePath(
      config.GCP_PROJECT,
      config.GCP_LOCATION,
      (isManual && process.env.CLOUD_TASKS_MANUAL_QUEUE) || config.CLOUD_TASKS_QUEUE,
    ),
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

const CANCELLED_MESSAGE = "Zrušeno vynulováním fronty.";

/** Deletes every task waiting in the Cloud Tasks queue. Returns null when Cloud Tasks isn't used. */
async function purgeCloudTasks(): Promise<{ ok: true } | { ok: false; error: string } | null> {
  const config = cloudTasksConfig();
  if (!config) return null;
  tasksClient ??= new CloudTasksClient();
  try {
    await tasksClient.purgeQueue({
      name: tasksClient.queuePath(config.GCP_PROJECT, config.GCP_LOCATION, config.CLOUD_TASKS_QUEUE),
    });
    return { ok: true };
  } catch (error) {
    console.error("Purging the Cloud Tasks queue failed", error);
    // gRPC code 7 = PERMISSION_DENIED.
    if ((error as { code?: number }).code === 7) {
      return {
        ok: false,
        error: "Aplikace nemá oprávnění vyprázdnit frontu Cloud Tasks (cloudtasks.queues.purge).",
      };
    }
    return { ok: false, error: `Vyprázdnění fronty Cloud Tasks selhalo: ${(error as Error).message ?? error}` };
  }
}

/**
 * Empties the job queue: purges Cloud Tasks and marks every queued or running job cancelled, so the
 * pending counters drop to zero. Tasks the purge misses find their job cancelled and do nothing;
 * running jobs stop the next time they try to queue more work. Nightly check records are dropped
 * too: they are saved when work is queued, so a purge would otherwise leave those collections
 * marked as checked and the next nightly run would skip them.
 */
export async function resetQueue(shop: string) {
  const purge = await purgeCloudTasks();
  const { count } = await db.job.updateMany({
    where: { shop, status: { in: ["queued", "running"] } },
    data: { status: "cancelled", message: CANCELLED_MESSAGE },
  });
  await db.collectionCheck.deleteMany({ where: { shop } });
  return { cancelled: count, purge };
}
