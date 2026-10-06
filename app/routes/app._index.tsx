import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { evaluateProduct } from "../lib/evaluate.server";
import { enqueueJob } from "../lib/queue.server";
import { getRules } from "../lib/settings.server";
import { gql, type AdminClient } from "../lib/shopify/api.server";
import { toGid } from "../lib/shopify/queries";

const TITLES_QUERY = `#graphql
  query JobTargets($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id title }
      ... on Collection { id title }
    }
  }`;

/** Pulls ids out of pasted text: numbers, GIDs or admin URLs, separated by anything. */
function parseIds(text: string, type: "Product" | "Collection") {
  const ids = new Set<string>();
  const invalid: string[] = [];
  for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
    const match = /(\d+)\/?$/.exec(token);
    if (match) ids.add(toGid(type, match[1]));
    else invalid.push(token);
  }
  return { ids: [...ids], invalid };
}

const MAX_LIST_IDS = 5000;

/** Jobs created in bulk, shown as a count instead of in the job list. */
const BATCH_JOBS = ["add-products", "sort-collection"];

/** The product or collection a job works on, taken from its payload. */
function jobTarget(payload: unknown): string | null {
  const p = (payload ?? {}) as { productId?: unknown; collectionId?: unknown };
  const id = p.productId ?? p.collectionId;
  return typeof id === "string" ? id : null;
}

/** Admin link for a product or collection GID, e.g. shopify://admin/products/123. */
function adminUrl(gid: string): string | null {
  const match = /^gid:\/\/shopify\/(Product|Collection)\/(\d+)$/.exec(gid);
  if (!match) return null;
  return `shopify://admin/${match[1] === "Product" ? "products" : "collections"}/${match[2]}`;
}

async function loadTitles(admin: AdminClient, ids: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (ids.length === 0) return titles;
  try {
    const data = await gql(admin, TITLES_QUERY, { ids });
    for (const node of data.nodes ?? []) if (node?.id) titles.set(node.id, node.title);
  } catch (error) {
    console.error("Loading job target titles failed", error);
  }
  return titles;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const [collectionCount, lastSync, jobs, rules, statusCounts] = await Promise.all([
    db.ruleCollection.count({ where: { shop } }),
    db.ruleCollection.aggregate({ where: { shop }, _max: { syncedAt: true } }),
    db.job.findMany({
      where: { shop, type: { notIn: BATCH_JOBS } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    getRules(shop),
    db.job.groupBy({
      by: ["status"],
      where: { shop, type: { notIn: BATCH_JOBS } },
      _count: { _all: true },
    }),
  ]);
  const targets = jobs.map((j) => jobTarget(j.payload));
  const titles = await loadTitles(
    admin as unknown as AdminClient,
    [...new Set(targets.filter((id): id is string => id !== null))],
  );
  const exportJobIds = jobs.filter((j) => j.type === "export-plan" && j.status === "done").map((j) => j.id);
  const exportFiles = await db.exportFile.findMany({
    where: { shop, OR: exportJobIds.map((id) => ({ id: { startsWith: `${id}-` } })) },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const [pendingAdds, pendingSorts] = await Promise.all(
    BATCH_JOBS.map((type) =>
      db.job.count({ where: { shop, type, status: { in: ["queued", "running"] } } }),
    ),
  );
  return {
    collectionCount,
    lastSync: lastSync._max.syncedAt?.toISOString() ?? null,
    pendingAdds,
    pendingSorts,
    filter: rules.collectionFilter,
    jobCounts: Object.fromEntries(statusCounts.map((c) => [c.status, c._count._all])) as Record<string, number>,
    jobs: jobs.map((j, i) => ({
      id: j.id,
      target: targets[i]
        ? { title: titles.get(targets[i]!) ?? targets[i]!.split("/").pop()!, url: adminUrl(targets[i]!) }
        : null,
      type: j.type,
      exportFiles: exportJobIds.length
        ? exportFiles.filter((f) => f.id.startsWith(`${j.id}-`)).map((f) => f.id)
        : [],
      status: j.status,
      message: j.message,
      createdAt: j.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const id = String(form.get("id") ?? "");

  switch (intent) {
    case "sync":
      await enqueueJob(shop, "sync-collections");
      return { message: "Synchronizace kolekcí spuštěna." };
    case "evaluate-all":
      await enqueueJob(shop, "evaluate-all");
      return { message: "Vyhodnocení všech produktů spuštěno." };
    case "export-plan":
      await enqueueJob(shop, "export-plan");
      return { message: "Export plánu spuštěn, po dokončení ho stáhnete v seznamu úloh." };
    case "sort-all":
      await enqueueJob(shop, "sort-all");
      return { message: "Řazení všech kolekcí spuštěno." };
    case "evaluate-collection":
      await enqueueJob(shop, "evaluate-collection", { collectionId: toGid("Collection", id) });
      return { message: "Vyhodnocení kolekce spuštěno." };
    case "evaluate-product": {
      const productId = toGid("Product", id);
      const result = await evaluateProduct(admin as unknown as AdminClient, shop, productId);
      const message = result
        ? `Produkt odpovídá ${result.matched} kolekcím, nově přidán do ${result.added}.`
        : "Produkt nenalezen.";
      // Recorded so the result stays visible in the job list after the toast disappears.
      await db.job.create({
        data: { shop, type: "evaluate-product", payload: { productId }, status: "done", message },
      });
      return { message };
    }
    case "evaluate-list": {
      const type = form.get("listType") === "collection" ? "Collection" : "Product";
      const { ids, invalid } = parseIds(String(form.get("ids") ?? ""), type);
      if (ids.length === 0) return { message: "Seznam neobsahuje žádné platné ID." };
      if (ids.length > MAX_LIST_IDS) return { message: `Najednou nejvýš ${MAX_LIST_IDS} ID.` };
      if (type === "Product") {
        for (const productId of ids) await enqueueJob(shop, "evaluate-product", { productId });
      } else {
        await enqueueJob(shop, "evaluate-collections", { collectionIds: ids });
      }
      const what = type === "Product" ? "produktů" : "kolekcí";
      return {
        message: `Vyhodnocení ${ids.length} ${what} spuštěno.` +
          (invalid.length ? ` Neplatné: ${invalid.slice(0, 5).join(", ")}${invalid.length > 5 ? "…" : ""}` : ""),
      };
    }
    default:
      return { message: "Neznámá akce." };
  }
};

const JOB_LABELS: Record<string, string> = {
  "sync-collections": "Synchronizace kolekcí",
  "sync-collection": "Aktualizace kolekce",
  "evaluate-product": "Vyhodnocení produktu",
  "evaluate-collection": "Vyhodnocení kolekce",
  "evaluate-collections": "Vyhodnocení seznamu kolekcí",
  "evaluate-all": "Vyhodnocení všeho",
  "sort-all": "Řazení všech kolekcí",
  "export-plan": "Export plánu",
};

/** Fetches an export (App Bridge adds the session token) and saves it as a file. */
async function downloadExport(id: string) {
  const response = await fetch(`/app/export/${id}`);
  if (!response.ok) throw new Error(await response.text());
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `plan-${id}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

const STATUS_TONES: Record<string, "info" | "success" | "critical" | "neutral"> = {
  queued: "neutral",
  running: "info",
  done: "success",
  failed: "critical",
};

const STATUS_LABELS: Record<string, string> = {
  queued: "Ve frontě",
  running: "Běží",
  done: "Hotovo",
  failed: "Chyba",
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message);
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const submit = (intent: string, id?: string) =>
    fetcher.submit({ intent, ...(id ? { id } : {}) }, { method: "POST" });

  const pick = async (type: "product" | "collection") => {
    const selection = await shopify.resourcePicker({ type, multiple: false });
    const id = selection?.[0]?.id;
    if (id) submit(type === "product" ? "evaluate-product" : "evaluate-collection", id);
  };

  return (
    <s-page heading="Zařazování produktů do kolekcí">
      <s-button slot="primary-action" onClick={() => submit("evaluate-all")} disabled={busy}>
        Vyhodnotit vše
      </s-button>

      <s-section heading="Kolekce s pravidly">
        <s-paragraph>
          Kolekce s metapolem <s-text type="strong">{data.filter.key}</s-text> ={" "}
          <s-text type="strong">{data.filter.value}</s-text>: {data.collectionCount}
          {data.lastSync ? `, naposledy načteno ${new Date(data.lastSync).toLocaleString("cs-CZ")}` : ", zatím nenačteno"}.
        </s-paragraph>
        {data.pendingAdds > 0 && (
          <s-paragraph>Čeká na zpracování {data.pendingAdds} dávek přiřazení.</s-paragraph>
        )}
        {data.pendingSorts > 0 && (
          <s-paragraph>Čeká na seřazení {data.pendingSorts} kolekcí.</s-paragraph>
        )}
        <s-stack direction="inline" gap="base">
          <s-button onClick={() => submit("sync")} disabled={busy}>
            Synchronizovat kolekce
          </s-button>
          <s-button onClick={() => pick("product")} disabled={busy}>
            Vyhodnotit produkt
          </s-button>
          <s-button onClick={() => pick("collection")} disabled={busy}>
            Vyhodnotit kolekci
          </s-button>
          <s-button onClick={() => submit("sort-all")} disabled={busy}>
            Seřadit kolekce
          </s-button>
          <s-button onClick={() => submit("export-plan")} disabled={busy}>
            Export plánu (CSV)
          </s-button>
          <s-button variant="tertiary" onClick={() => revalidator.revalidate()}>
            Obnovit
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Vyhodnotit podle seznamu ID">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="evaluate-list" />
          <s-stack gap="base">
            <s-select name="listType" label="Typ">
              <s-option value="product">Produkty</s-option>
              <s-option value="collection">Kolekce</s-option>
            </s-select>
            <s-text-area
              name="ids"
              label="ID (číslo, GID nebo odkaz z adminu; oddělené řádkem, čárkou nebo mezerou)"
              rows={5}
            />
            <s-button type="submit" disabled={busy}>
              Vyhodnotit seznam
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading="Poslední úlohy">
        {data.jobs.length > 0 && (
          <s-paragraph>
            Celkem {Object.values(data.jobCounts).reduce((sum, n) => sum + n, 0)} úloh:{" "}
            {Object.keys(STATUS_LABELS)
              .map((status) => `${STATUS_LABELS[status]} ${data.jobCounts[status] ?? 0}`)
              .join(", ")}
            .
          </s-paragraph>
        )}
        {data.jobs.length === 0 ? (
          <s-paragraph>Zatím žádné úlohy.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Čas</s-table-header>
              <s-table-header>Úloha</s-table-header>
              <s-table-header>Produkt / kolekce</s-table-header>
              <s-table-header>Stav</s-table-header>
              <s-table-header>Výsledek</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.jobs.map((job) => (
                <s-table-row key={job.id}>
                  <s-table-cell>{new Date(job.createdAt).toLocaleString("cs-CZ")}</s-table-cell>
                  <s-table-cell>{JOB_LABELS[job.type] ?? job.type}</s-table-cell>
                  <s-table-cell>
                    {job.target?.url ? (
                      <s-link href={job.target.url} target="_blank">{job.target.title}</s-link>
                    ) : (
                      job.target?.title ?? ""
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONES[job.status] ?? "neutral"}>
                      {STATUS_LABELS[job.status] ?? job.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {job.message ?? ""}
                    {job.exportFiles.map((fileId, i) => (
                      <s-button
                        key={fileId}
                        variant="tertiary"
                        onClick={() =>
                          downloadExport(fileId).catch((error) => shopify.toast.show(String(error), { isError: true }))
                        }
                      >
                        Soubor {i + 1}
                      </s-button>
                    ))}
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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
