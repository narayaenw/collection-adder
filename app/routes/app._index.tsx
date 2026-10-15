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
import type { AdminClient } from "../lib/shopify/api.server";
import { toGid } from "../lib/shopify/queries";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const [collectionCount, lastSync, jobs, rules] = await Promise.all([
    db.ruleCollection.count({ where: { shop } }),
    db.ruleCollection.aggregate({ where: { shop }, _max: { syncedAt: true } }),
    db.job.findMany({
      where: { shop, type: { not: "add-products" } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    getRules(shop),
  ]);
  const pendingAdds = await db.job.count({
    where: { shop, type: "add-products", status: { in: ["queued", "running"] } },
  });
  return {
    collectionCount,
    lastSync: lastSync._max.syncedAt?.toISOString() ?? null,
    pendingAdds,
    filter: rules.collectionFilter,
    jobs: jobs.map((j) => ({
      id: j.id,
      type: j.type,
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
    case "evaluate-collection":
      await enqueueJob(shop, "evaluate-collection", { collectionId: toGid("Collection", id) });
      return { message: "Vyhodnocení kolekce spuštěno." };
    case "evaluate-product": {
      const result = await evaluateProduct(admin as unknown as AdminClient, shop, toGid("Product", id));
      return {
        message: result
          ? `Produkt odpovídá ${result.matched} kolekcím, nově přidán do ${result.added}.`
          : "Produkt nenalezen.",
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
  "evaluate-all": "Vyhodnocení všeho",
};

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
          <s-button variant="tertiary" onClick={() => revalidator.revalidate()}>
            Obnovit
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Poslední úlohy">
        {data.jobs.length === 0 ? (
          <s-paragraph>Zatím žádné úlohy.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Čas</s-table-header>
              <s-table-header>Úloha</s-table-header>
              <s-table-header>Stav</s-table-header>
              <s-table-header>Výsledek</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.jobs.map((job) => (
                <s-table-row key={job.id}>
                  <s-table-cell>{new Date(job.createdAt).toLocaleString("cs-CZ")}</s-table-cell>
                  <s-table-cell>{JOB_LABELS[job.type] ?? job.type}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONES[job.status] ?? "neutral"}>
                      {STATUS_LABELS[job.status] ?? job.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{job.message ?? ""}</s-table-cell>
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
