import db from "../db.server";

/** How long finished jobs and removal reports are kept. */
export const KEEP_DAYS = 14;
/** Rows deleted per statement, so one delete never holds locks or builds WAL for long. */
const BATCH = 20_000;
/** Stops in time for the request limit; the rest is deleted the next time. */
const TIME_BUDGET_MS = 20 * 60 * 1000;

export type PruneResult = { removalItems: number; jobs: number; done: boolean };

/**
 * Deletes removal report rows and finished jobs older than KEEP_DAYS, in small batches.
 * Queued and running jobs are never touched. Returns done=false when the time ran out.
 */
export async function pruneHistory(shop: string, now = Date.now()): Promise<PruneResult> {
  const cutoff = new Date(now - KEEP_DAYS * 24 * 60 * 60 * 1000);
  const deadline = now + TIME_BUDGET_MS;
  const result: PruneResult = { removalItems: 0, jobs: 0, done: false };

  // Removal rows go by run (indexed), before the run's job row, so none are left without a run.
  const oldRuns = await db.job.findMany({
    where: { shop, type: "remove-unmatched", createdAt: { lt: cutoff } },
    select: { id: true },
  });
  for (const { id: runId } of oldRuns) {
    for (;;) {
      if (Date.now() > deadline) return result;
      const count = await db.$executeRaw`
        DELETE FROM "RemovalItem" WHERE ctid IN (
          SELECT ctid FROM "RemovalItem" WHERE "shop" = ${shop} AND "runId" = ${runId} LIMIT ${BATCH})`;
      result.removalItems += count;
      if (count < BATCH) break;
    }
  }
  for (;;) {
    if (Date.now() > deadline) return result;
    const count = await db.$executeRaw`
      DELETE FROM "Job" WHERE ctid IN (
        SELECT ctid FROM "Job"
        WHERE "shop" = ${shop} AND "createdAt" < ${cutoff} AND "status" NOT IN ('queued', 'running')
        LIMIT ${BATCH})`;
    result.jobs += count;
    if (count < BATCH) break;
  }
  result.done = true;
  return result;
}

export function pruneSummary({ removalItems, jobs, done }: PruneResult) {
  return `Smazáno ${removalItems} záznamů o odebírání a ${jobs} úloh starších ${KEEP_DAYS} dní` +
    (done ? "." : ", zbytek se smaže v dalším běhu.");
}
