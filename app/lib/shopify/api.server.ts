/* eslint-disable @typescript-eslint/no-explicit-any -- Shopify GraphQL responses are untyped JSON. */
/** Minimal shape of the admin GraphQL client, so jobs and routes can share helpers. */
export interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isThrottled(error: unknown): boolean {
  const e = error as { message?: string; body?: unknown; response?: { code?: number } };
  const text = `${e?.message ?? ""} ${JSON.stringify(e?.body ?? "")}`;
  return /throttled/i.test(text) || e?.response?.code === 429;
}

/**
 * Runs an Admin GraphQL operation and returns `data`. Retries with backoff while Shopify
 * throttles the request, so a long job keeps going under the API rate limit.
 */
export async function gql<T = any>(
  admin: AdminClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const maxAttempts = 10;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await admin.graphql(query, { variables });
      const json = (await response.json()) as { data?: T; errors?: unknown };
      if (json.errors) {
        const error = new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
        if (isThrottled(error) && attempt < maxAttempts) {
          await sleep(Math.min(2000 * attempt, 20000));
          continue;
        }
        throw error;
      }
      return json.data as T;
    } catch (error) {
      if (isThrottled(error) && attempt < maxAttempts) {
        await sleep(Math.min(2000 * attempt, 20000));
        continue;
      }
      throw error;
    }
  }
}

export function assertNoUserErrors(
  operation: string,
  userErrors: { field?: string[] | null; message: string }[] | undefined,
) {
  if (userErrors && userErrors.length > 0) {
    throw new Error(`${operation}: ${userErrors.map((e) => e.message).join("; ")}`);
  }
}

const RUN_BULK = `#graphql
  mutation RunBulkQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }`;

const BULK_STATUS = `#graphql
  query BulkStatus($id: ID!) {
    node(id: $id) {
      ... on BulkOperation { id status errorCode objectCount url partialDataUrl }
    }
  }`;

/**
 * Runs a bulk query and returns the parsed JSONL rows. Used for reading all collections
 * or all products, which would take thousands of paginated requests otherwise.
 */
export async function runBulkQuery(admin: AdminClient, query: string): Promise<any[]> {
  const rows: any[] = [];
  await forEachBulkRow(admin, query, (row) => rows.push(row));
  return rows;
}

/**
 * Runs a bulk query and passes each parsed JSONL row to onRow. The result is streamed line by
 * line because a full product export can exceed the maximum string length.
 */
export async function forEachBulkRow(
  admin: AdminClient,
  query: string,
  onRow: (row: any) => void,
): Promise<void> {
  let operationId: string | undefined;
  for (let attempt = 1; attempt <= 60 && !operationId; attempt++) {
    const data = await gql(admin, RUN_BULK, { query });
    const errors = data.bulkOperationRunQuery.userErrors as { message: string }[];
    if (errors.length > 0) {
      // Another bulk query is still running for this shop; wait for it to finish.
      if (errors.some((e) => /in progress|already/i.test(e.message))) {
        await sleep(10000);
        continue;
      }
      assertNoUserErrors("bulkOperationRunQuery", errors);
    }
    operationId = data.bulkOperationRunQuery.bulkOperation.id;
  }
  if (!operationId) throw new Error("Bulk query could not start: another one is still running.");

  let url: string | null = null;
  for (;;) {
    await sleep(3000);
    const data = await gql(admin, BULK_STATUS, { id: operationId });
    const op = data.node;
    if (op.status === "COMPLETED") {
      url = op.url;
      break;
    }
    if (["FAILED", "CANCELED", "EXPIRED"].includes(op.status)) {
      throw new Error(`Bulk query ${op.status}: ${op.errorCode ?? "unknown error"}`);
    }
  }

  if (!url) return; // No rows matched.
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Bulk result download failed: ${response.status}`);
  const decoder = new TextDecoder();
  let pending = "";
  const emit = (line: string) => {
    if (line.trim() !== "") onRow(JSON.parse(line));
  };
  for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
    const lines = (pending + decoder.decode(bytes, { stream: true })).split("\n");
    pending = lines.pop()!;
    lines.forEach(emit);
  }
  emit(pending + decoder.decode());
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
