import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
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

/**
 * Cloud Tasks queue a job goes to, so long runs don't hold up other work:
 * - webhooks: collection refreshes and new products (short jobs that should never wait);
 * - manual: evaluations started by hand (lists, follow-ups);
 * - main: nightly runs and the bulk buttons (sync, evaluate all, removal, exports).
 * Jobs a job queues go to the same queue as their parent.
 */
export type QueueName = "main" | "manual" | "webhooks";

const currentJob = new AsyncLocalStorage<{ id: string; checkedAt: number; manual: boolean; queue?: QueueName }>();
const CANCEL_CHECK_MS = 5000;

/**
 * Runs a job's handler so that jobs it enqueues can notice it was cancelled, and so that jobs
 * started by hand pass that on to the jobs they queue.
 */
export function runInJob<T>(jobId: string, fn: () => Promise<T>, manual = false, queue?: QueueName): Promise<T> {
  return currentJob.run({ id: jobId, checkedAt: Date.now(), manual, queue }, fn);
}

function queuePathName(queue: QueueName, mainQueue: string): string {
  if (queue === "webhooks") {
    return process.env.CLOUD_TASKS_WEBHOOK_QUEUE || process.env.CLOUD_TASKS_MANUAL_QUEUE || mainQueue;
  }
  if (queue === "manual") return process.env.CLOUD_TASKS_MANUAL_QUEUE || mainQueue;
  return mainQueue;
}

/** Queue of a stored job; jobs from before the queues were split go by their manual flag. */
export function queueOfPayload(payload: unknown): QueueName {
  const p = (payload ?? {}) as { queue?: unknown; manual?: unknown };
  if (p.queue === "main" || p.queue === "manual" || p.queue === "webhooks") return p.queue;
  return p.manual === true ? "manual" : "main";
}

/** Every distinct Cloud Tasks queue the app uses. */
function allQueueNames(mainQueue: string): string[] {
  return [...new Set((["main", "manual", "webhooks"] as const).map((q) => queuePathName(q, mainQueue)))];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Jobs of one type with the same payload (ignoring which run or queue they belong to) do the
 * same work, so a second one is skipped while the first still waits: a double click, the same
 * id twice in a list, or the same collection queued by two runs.
 */
export function dedupKeyFor(type: JobType, payload: Record<string, unknown>): string {
  const work = { ...payload };
  delete work.manual;
  delete work.queue;
  delete work.runId;
  return `${type}:${createHash("sha1").update(stableJson(work)).digest("hex")}`;
}

/** A queued job older than this no longer blocks a duplicate (its task may be long gone). */
const DEDUP_WINDOW_MS = 24 * 3600 * 1000;

async function assertCurrentJobActive() {
  const job = currentJob.getStore();
  if (!job || Date.now() - job.checkedAt < CANCEL_CHECK_MS) return;
  job.checkedAt = Date.now();
  const row = await db.job.findUnique({ where: { id: job.id }, select: { status: true } });
  if (row?.status === "cancelled") throw new JobCancelledError(`Job ${job.id} was cancelled`);
}

/**
 * Stores a job and hands it to its queue (see QueueName). In production Cloud Tasks calls
 * /jobs/run, which spreads work over time and retries failures; each queue's rate settings keep
 * the app under Shopify's API limits. Jobs started by hand (`manual`, or queued by such a job)
 * are marked so they run even with JOBS_DISABLED. A job identical to one still queued is not
 * queued again; the waiting one is returned.
 */
export async function enqueueJob(
  shop: string,
  type: JobType,
  payload: Record<string, unknown> = {},
  { delaySeconds = 0, manual, queue }: { delaySeconds?: number; manual?: boolean; queue?: QueueName } = {},
) {
  await assertCurrentJobActive();
  const parent = currentJob.getStore();
  const isManual = manual ?? parent?.manual ?? false;
  const target: QueueName = queue ?? parent?.queue ?? (isManual ? "manual" : "main");
  const data = { ...payload, ...(isManual ? { manual: true } : {}), queue: target };
  const dedupKey = dedupKeyFor(type, payload);
  const waiting = await db.job.findFirst({
    where: { shop, dedupKey, status: "queued", createdAt: { gte: new Date(Date.now() - DEDUP_WINDOW_MS) } },
  });
  if (waiting) return waiting;
  const runAt = new Date(Date.now() + delaySeconds * 1000);
  const job = await db.job.create({ data: { shop, type, payload: data as object, dedupKey, runAt } });
  const config = cloudTasksConfig();

  if (!config) {
    runLocally(job.id, delaySeconds);
    return job;
  }

  tasksClient ??= new CloudTasksClient();
  try {
    await tasksClient.createTask({
      parent: tasksClient.queuePath(config.GCP_PROJECT, config.GCP_LOCATION, queuePathName(target, config.CLOUD_TASKS_QUEUE)),
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
  } catch (error) {
    // No task will run this job, so it must not stay queued (it would block its duplicates).
    await db.job.update({
      where: { id: job.id },
      data: { status: "failed", message: `Zařazení do fronty selhalo: ${(error as Error).message ?? error}`.slice(0, 2000) },
    });
    throw error;
  }
  return job;
}

const CANCELLED_MESSAGE = "Zrušeno vynulováním fronty.";

/** Deletes every task waiting in the Cloud Tasks queues. Returns null when Cloud Tasks isn't used. */
async function purgeCloudTasks(): Promise<{ ok: true } | { ok: false; error: string } | null> {
  const config = cloudTasksConfig();
  if (!config) return null;
  tasksClient ??= new CloudTasksClient();
  try {
    for (const queue of allQueueNames(config.CLOUD_TASKS_QUEUE)) {
      await tasksClient.purgeQueue({ name: tasksClient.queuePath(config.GCP_PROJECT, config.GCP_LOCATION, queue) });
    }
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
 * Empties the job queues: purges Cloud Tasks and marks every queued or running job cancelled, so the
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
