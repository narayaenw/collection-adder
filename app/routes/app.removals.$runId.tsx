import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

const csvCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
const numericId = (gid: string) => gid.split("/").pop()!;

/** Downloads the products a removal run found, as CSV. */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const items = await db.removalItem.findMany({
    where: { shop: session.shop, runId: params.runId },
    orderBy: [{ collectionTitle: "asc" }, { productTitle: "asc" }],
  });
  const lines = items.map((i) =>
    [
      numericId(i.collectionId),
      csvCell(i.collectionTitle),
      numericId(i.productId),
      csvCell(i.productTitle),
      csvCell(i.vendor),
      i.removed ? "ano" : "ne",
    ].join(","),
  );
  const header = "collection_id,collection_title,product_id,product_title,vendor,odebrano";
  // BOM so Excel opens the file as UTF-8.
  return new Response(`\uFEFF${[header, ...lines].join("\n")}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="odebrani-${params.runId}.csv"`,
    },
  });
};
