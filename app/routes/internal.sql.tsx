import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { hasValidJobsSecret } from "../lib/jobs-auth.server";
import { isReadOnlyQuery, toJsonSafe } from "../lib/readonly-sql";

const MAX_ROWS = 5000;

// Read-only access to the app database for maintenance (same secret as the job endpoints).
// The query runs in a READ ONLY transaction with a 60 s limit, so it cannot change data.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!hasValidJobsSecret(request)) return new Response("Unauthorized", { status: 401 });
  const { sql } = (await request.json().catch(() => ({}))) as { sql?: string };
  if (!sql || !isReadOnlyQuery(sql)) {
    return Response.json({ error: "Only one SELECT/WITH/EXPLAIN query is allowed." }, { status: 400 });
  }
  try {
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = 60000");
      return tx.$queryRawUnsafe<unknown[]>(sql);
    }, { timeout: 70_000 });
    return Response.json({
      rowCount: rows.length,
      truncated: rows.length > MAX_ROWS,
      rows: toJsonSafe(rows.slice(0, MAX_ROWS)),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
};
