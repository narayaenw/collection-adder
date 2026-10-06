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
