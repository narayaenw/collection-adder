import { timingSafeEqual } from "node:crypto";

/** Checks the shared secret Cloud Tasks and Cloud Scheduler send with each call. */
export function hasValidJobsSecret(request: Request): boolean {
  const expected = process.env.JOBS_SECRET;
  const given = request.headers.get("x-jobs-secret");
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Kill switch: with JOBS_DISABLED=1 on Cloud Run the app runs no jobs. Cloud Tasks gets 503 and
 * keeps the task for a later retry, so nothing is lost while the switch is on.
 */
export function jobsDisabled(): boolean {
  return ["1", "true", "yes"].includes((process.env.JOBS_DISABLED ?? "").trim().toLowerCase());
}
