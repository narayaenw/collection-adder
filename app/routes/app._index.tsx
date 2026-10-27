import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { countParentCollections } from "../lib/collections.server";
import { evaluateProduct } from "../lib/evaluate.server";
import { enqueueJob, resetQueue } from "../lib/queue.server";
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
const BATCH_JOBS = ["add-products", "sort-collection", "clean-collection", "evaluate-group"];

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
  const [collectionCount, parentCount, lastSync, jobs, rules, statusCounts] = await Promise.all([
    db.ruleCollection.count({ where: { shop } }),
    countParentCollections(shop),
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
  const exportJobIds = jobs
    .filter((j) => ["export-plan", "export-rule-groups", "remove-smart-rules"].includes(j.type) && j.status === "done").map((j) => j.id);
  const exportFiles = await db.exportFile.findMany({
    where: { shop, OR: exportJobIds.map((id) => ({ id: { startsWith: `${id}-` } })) },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const [pendingAdds, pendingSorts, pendingCleans] = await Promise.all(
    BATCH_JOBS.map((type) =>
      db.job.count({ where: { shop, type, status: { in: ["queued", "running"] } } }),
    ),
  );
  const lastRemoval = await db.job.findFirst({
    where: { shop, type: "remove-unmatched" },
    orderBy: { createdAt: "desc" },
  });
  const removalCounts = lastRemoval
    ? await db.removalItem.groupBy({
        by: ["removed"],
        where: { shop, runId: lastRemoval.id },
        _count: { _all: true },
      })
    : [];
  return {
    // Parents are only sorted; filling and removal skip them.
    collectionCount: collectionCount - parentCount,
    parentCount,
    pendingCleans,
    removal: {
      enabled: rules.removal.enabled,
      nightly: rules.removal.nightly,
      last: lastRemoval
        ? {
            id: lastRemoval.id,
            createdAt: lastRemoval.createdAt.toISOString(),
            message: lastRemoval.message,
            found: removalCounts.reduce((sum, c) => sum + c._count._all, 0),
            removed: removalCounts.find((c) => c.removed)?._count._all ?? 0,
          }
        : null,
    },
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
    case "export-plan": {
      const excludeTitles = String(form.get("excludeTitles") ?? "")
        .split(/[,\n]/)
        .map((t) => t.trim())
        .filter(Boolean);
      const activeOnly = form.get("activeOnly") === "on";
      await enqueueJob(shop, "export-plan", { excludeTitles, activeOnly });
      return { message: "Export plánu spuštěn, po dokončení ho stáhnete v seznamu úloh." };
    }
    case "export-rule-groups":
      await enqueueJob(shop, "export-rule-groups");
      return { message: "Report spuštěn, po dokončení ho stáhnete v seznamu úloh." };
    case "remove-unmatched": {
      await enqueueJob(shop, "remove-unmatched");
      const { removal } = await getRules(shop);
      return {
        message: removal.enabled
          ? "Odebírání nevyhovujících produktů spuštěno."
          : "Kontrola nanečisto spuštěna, nic se neodebere.",
      };
    }
    case "remove-smart-rules":
      await enqueueJob(shop, "remove-smart-rules");
      return { message: "Mazání pravidel spuštěno, výsledek uvidíte v seznamu úloh." };
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
    case "reset-queue": {
      const { cancelled, purge } = await resetQueue(shop);
      const jobs = `Zrušeno ${cancelled} úloh ve frontě.`;
      if (!purge || purge.ok) return { message: `Fronta vynulována. ${jobs}` };
      return { message: `${jobs} ${purge.error} Zbylé úlohy v ní doběhnou naprázdno.` };
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
  "evaluate-group": "Vyhodnocení skupiny kolekcí",
  "sort-all": "Řazení všech kolekcí",
  "export-plan": "Export plánu",
  "export-rule-groups": "Report shodných pravidel",
  "remove-unmatched": "Odebrání nevyhovujících",
  "remove-smart-rules": "Smazání pravidel smart kolekcí",
};

/** Fetches an export (App Bridge adds the session token) and saves it as a file. */
async function downloadExport(id: string, path = `/app/export/${id}`, name = `plan-${id}.csv`) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(await response.text());
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

const STATUS_TONES: Record<string, "info" | "success" | "critical" | "warning" | "neutral"> = {
  queued: "neutral",
  cancelled: "warning",
  running: "info",
  done: "success",
  failed: "critical",
};

const STATUS_LABELS: Record<string, string> = {
  queued: "Ve frontě",
  running: "Běží",
  done: "Hotovo",
  failed: "Chyba",
  cancelled: "Zrušeno",
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const busy = fetcher.state !== "idle";
  const [confirmReset, setConfirmReset] = useState(false);

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
        {data.parentCount > 0 && (
          <s-paragraph>
            Z přiřazování a odebírání vynecháno {data.parentCount} nadřazených kolekcí (mají podkolekce
            v metapoli custom.subkolekce, produkty do nich propisuje Shopify); řadí se dál.
          </s-paragraph>
        )}
        {data.pendingAdds > 0 && (
          <s-paragraph>Čeká na zpracování {data.pendingAdds} dávek přiřazení.</s-paragraph>
        )}
        {data.pendingSorts > 0 && (
          <s-paragraph>Čeká na seřazení {data.pendingSorts} kolekcí.</s-paragraph>
        )}
        <s-paragraph>
          {data.removal.enabled
            ? "Vyhodnotit kolekci i Vyhodnotit seznam přidají vyhovující produkty a nevyhovující z kolekcí odeberou (Ostré odebírání je zapnuté)."
            : "Vyhodnotit kolekci i Vyhodnotit seznam jen přidávají vyhovující produkty; odebírají až se zapnutým Ostrým odebíráním."}
        </s-paragraph>
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
          <s-button variant="tertiary" onClick={() => revalidator.revalidate()}>
            Obnovit
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Odebírání nevyhovujících produktů">
        <s-stack gap="base">
          <s-paragraph>
            {data.removal.enabled
              ? "Ostré odebírání je zapnuté: nevyhovující produkty se z kolekcí odeberou."
              : "Ostré odebírání je vypnuté: kontrola jen vypíše, co by se odebralo."}{" "}
            {data.removal.nightly ? "Spouští se každou noc." : "Noční spouštění je vypnuté."} Změna v
            nastavení.
          </s-paragraph>
          {data.removal.last && (
            <s-paragraph>
              Poslední běh {new Date(data.removal.last.createdAt).toLocaleString("cs-CZ")}:{" "}
              {data.removal.last.message ?? "čeká ve frontě"} Zatím nalezeno{" "}
              {data.removal.last.found} nevyhovujících, odebráno {data.removal.last.removed}.
              {data.pendingCleans > 0 && ` Zbývá zkontrolovat ${data.pendingCleans} kolekcí.`}
            </s-paragraph>
          )}
          <s-stack direction="inline" gap="base">
            <s-button onClick={() => submit("remove-unmatched")} disabled={busy}>
              {data.removal.enabled ? "Odebrat nevyhovující" : "Zkontrolovat nanečisto"}
            </s-button>
            {data.removal.last && data.removal.last.found > 0 && (
              <s-button
                variant="tertiary"
                onClick={() =>
                  downloadExport(
                    data.removal.last!.id,
                    `/app/removals/${data.removal.last!.id}`,
                    `odebrani-${data.removal.last!.id}.csv`,
                  ).catch((error) => shopify.toast.show(String(error), { isError: true }))
                }
              >
                Stáhnout CSV
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Export plánu (CSV)">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="export-plan" />
          <s-stack gap="base">
            <s-text-field
              name="excludeTitles"
              label="Vynechat produkty, jejichž název obsahuje (více textů oddělte čárkou)"
              placeholder="např. BLANK"
            />
            <s-checkbox name="activeOnly" value="on" label="Jen aktivní produkty" defaultChecked />
            <s-button type="submit" disabled={busy}>
              Spustit export
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading="Report shodných pravidel (CSV)">
        <s-stack gap="base">
          <s-paragraph>
            Pro každou nadřazenou kolekci spočítá, kolik jejích podkolekcí (motorizací) má stejné
            hodnoty pravidel.
          </s-paragraph>
          <s-button onClick={() => submit("export-rule-groups")} disabled={busy}>
            Spustit report
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Vynulovat frontu">
        <s-stack gap="base">
          <s-paragraph>
            Smaže všechny čekající úlohy z fronty (přiřazení, řazení, odebírání i rozběhnuté
            vyhodnocení) a označí je jako zrušené. Potom lze začít od čista, např. tlačítkem
            Vyhodnotit vše. Už provedené změny v kolekcích zůstanou.
          </s-paragraph>
          {confirmReset ? (
            <s-stack direction="inline" gap="base">
              <s-button
                tone="critical"
                variant="primary"
                onClick={() => {
                  setConfirmReset(false);
                  submit("reset-queue");
                }}
                disabled={busy}
              >
                Opravdu vynulovat frontu
              </s-button>
              <s-button onClick={() => setConfirmReset(false)}>Zpět</s-button>
            </s-stack>
          ) : (
            <s-button tone="critical" onClick={() => setConfirmReset(true)} disabled={busy}>
              Vynulovat frontu
            </s-button>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Smazat pravidla nových smart kolekcí">
        <s-stack gap="base">
          <s-paragraph>
            Jednorázově smaže pravidla (podmínky) smart kolekcím se značkou účelu, které vznikly
            po 1. 10. 2026. Produkty přidané pravidly z nich zmizí. Smazaná pravidla budou v CSV.
          </s-paragraph>
          <s-button tone="critical" onClick={() => submit("remove-smart-rules")} disabled={busy}>
            Smazat pravidla
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
