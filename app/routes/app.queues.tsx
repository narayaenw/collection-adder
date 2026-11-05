import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Prisma } from "@prisma/client";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { JOB_LABELS } from "../lib/job-labels";
import { adminUrl, jobTarget, loadTitles } from "../lib/job-targets.server";
import type { QueueName } from "../lib/queue.server";
import type { AdminClient } from "../lib/shopify/api.server";

const QUEUES: { name: QueueName; title: string; description: string }[] = [
  { name: "webhooks", title: "Webhooky", description: "Aktualizace kolekcí a nové produkty." },
  { name: "manual", title: "Ruční", description: "Vyhodnocení spuštěná ručně (seznamy) a jejich navazující úlohy." },
  { name: "main", title: "Hlavní", description: "Noční běh a hromadná tlačítka (synchronizace, Vyhodnotit vše, Odebrat nevyhovující, exporty)." },
];

/** Rows listed per queue; the counts cover all of them. */
const ROWS = 200;

// Jobs from before the queues were split carry no queue; they go by their manual flag.
const QUEUE_SQL = Prisma.sql`COALESCE("payload"->>'queue', CASE WHEN "payload"->>'manual' = 'true' THEN 'manual' ELSE 'main' END)`;

interface Row {
  id: string;
  type: string;
  status: string;
  payload: unknown;
  attempts: number;
  message: string | null;
  createdAt: Date;
  runAt: Date | null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const asked = new URL(request.url).searchParams.get("queue");
  const queue = QUEUES.find((q) => q.name === asked)?.name ?? "webhooks";

  const counts = await db.$queryRaw<{ queue: string; status: string; count: bigint }[]>`
    SELECT ${QUEUE_SQL} AS queue, "status", COUNT(*) AS count
    FROM "Job"
    WHERE "shop" = ${shop} AND "status" IN ('queued', 'running')
    GROUP BY 1, 2`;
  // Running first, then by when the task is due (oldest first), as Cloud Tasks hands them out.
  const rows = await db.$queryRaw<Row[]>`
    SELECT "id", "type", "status", "payload", "attempts", "message", "createdAt", "runAt"
    FROM "Job"
    WHERE "shop" = ${shop} AND "status" IN ('queued', 'running') AND ${QUEUE_SQL} = ${queue}
    ORDER BY ("status" = 'running') DESC, COALESCE("runAt", "createdAt") ASC, "createdAt" ASC
    LIMIT ${ROWS}`;

  const now = Date.now();
  const targets = rows.map((r) => jobTarget(r.payload));
  const titles = await loadTitles(
    admin as unknown as AdminClient,
    [...new Set(targets.filter((t): t is string => t !== null))],
  );

  const summary = Object.fromEntries(QUEUES.map((q) => [q.name, { queued: 0, running: 0 }]));
  for (const c of counts) {
    const s = summary[c.queue];
    if (s && (c.status === "queued" || c.status === "running")) s[c.status] = Number(c.count);
  }

  return {
    queue,
    summary,
    jobs: rows.map((r, i) => {
      const target = targets[i];
      const ids = (r.payload as { collectionIds?: unknown } | null)?.collectionIds;
      return {
        id: r.id,
        type: r.type,
        status: r.status,
        attempts: r.attempts,
        message: r.message,
        createdAt: r.createdAt.toISOString(),
        runAt: (r.runAt ?? r.createdAt).toISOString(),
        later: (r.runAt ?? r.createdAt).getTime() > now,
        target: target
          ? { title: titles.get(target) ?? target.split("/").pop()!, url: adminUrl(target) }
          : Array.isArray(ids)
            ? { title: `${ids.length} kolekcí`, url: null }
            : null,
      };
    }),
  };
};

const time = (iso: string) => new Date(iso).toLocaleString("cs-CZ");

export default function Queues() {
  const data = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const current = QUEUES.find((q) => q.name === data.queue)!;
  const counts = data.summary[data.queue];

  return (
    <s-page heading="Fronty úloh">
      <s-section>
        <s-stack direction="inline" gap="base">
          {QUEUES.map((q) => (
            <s-button
              key={q.name}
              href={`/app/queues?queue=${q.name}`}
              variant={q.name === data.queue ? "primary" : "secondary"}
            >
              {`${q.title} (${data.summary[q.name].running + data.summary[q.name].queued})`}
            </s-button>
          ))}
          <s-button variant="tertiary" onClick={() => revalidator.revalidate()}>
            Obnovit
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading={`Fronta ${current.title}`}>
        <s-paragraph>{current.description}</s-paragraph>
        <s-paragraph>
          Běží {counts.running}, čeká {counts.queued}.
          {counts.running + counts.queued > data.jobs.length
            ? ` Zobrazeno prvních ${data.jobs.length}.`
            : ""}{" "}
          Pořadí: běžící, pak čekající podle času naplánování (Cloud Tasks je odbavuje přibližně v tomto pořadí).
        </s-paragraph>
        {data.jobs.length === 0 ? (
          <s-paragraph>Fronta je prázdná.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>#</s-table-header>
              <s-table-header>Naplánováno</s-table-header>
              <s-table-header>Úloha</s-table-header>
              <s-table-header>Produkt / kolekce</s-table-header>
              <s-table-header>Stav</s-table-header>
              <s-table-header>Poznámka</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.jobs.map((job, i) => (
                <s-table-row key={job.id}>
                  <s-table-cell>{i + 1}</s-table-cell>
                  <s-table-cell>
                    {time(job.runAt)}
                    {job.later ? " (později)" : ""}
                  </s-table-cell>
                  <s-table-cell>{JOB_LABELS[job.type] ?? job.type}</s-table-cell>
                  <s-table-cell>
                    {job.target?.url ? (
                      <s-link href={job.target.url} target="_blank">{job.target.title}</s-link>
                    ) : (
                      job.target?.title ?? ""
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={job.status === "running" ? "info" : job.attempts > 0 ? "warning" : "neutral"}>
                      {job.status === "running" ? "Běží" : job.attempts > 0 ? `Opakuje (${job.attempts}×)` : "Čeká"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {job.message ?? ""}
                    {job.runAt !== job.createdAt ? ` Vytvořeno ${time(job.createdAt)}.` : ""}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
