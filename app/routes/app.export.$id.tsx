import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

/** Downloads a CSV produced by the export-plan job. */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const file = await db.exportFile.findFirst({ where: { id: params.id, shop: session.shop } });
  if (!file) return new Response("Export nenalezen", { status: 404 });
  // BOM so Excel opens the file as UTF-8.
  return new Response(`\uFEFF${file.csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="plan-${file.id}.csv"`,
    },
  });
};
