/** Statements the read-only SQL endpoint accepts: one query that only reads. */
export function isReadOnlyQuery(sql: string): boolean {
  const text = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");
  if (!text || text.includes(";")) return false;
  return /^(select|with|explain|show|table|values)\b/i.test(text);
}

/** Makes query rows JSON-safe (Postgres bigint and numeric come back as BigInt / Decimal). */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    if (typeof (value as { toFixed?: unknown }).toFixed === "function" && "d" in value) {
      return Number(String(value));
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}
