import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { evaluateProduct } from "../lib/evaluate.server";
import { enqueueJob } from "../lib/queue.server";
import { gql, type AdminClient } from "../lib/shopify/api.server";
import { toGid } from "../lib/shopify/queries";

// Opened from the "More actions" links on a product or collection page in the Shopify admin.
// The admin appends the resource id as ?id=.

const TITLE_QUERY = `#graphql
  query ResourceTitle($id: ID!) {
    node(id: $id) {
      ... on Product { title }
      ... on Collection { title }
    }
  }`;

function resolve(params: { type?: string }, request: Request) {
  const type = params.type === "collection" ? "Collection" : params.type === "product" ? "Product" : null;
  const id = new URL(request.url).searchParams.get("id");
  if (!type || !id) throw new Response("Chybí typ nebo ID", { status: 400 });
  return { type, id: toGid(type, id) } as const;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const { type, id } = resolve(params, request);
  const data = await gql(admin as unknown as AdminClient, TITLE_QUERY, { id });
  return { type, id, title: (data.node?.title as string | undefined) ?? id };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { type, id } = resolve(params, request);
  if (type === "Collection") {
    await enqueueJob(session.shop, "evaluate-collection", { collectionId: id });
    return { message: "Vyhodnocení kolekce běží na pozadí. Výsledek uvidíte v přehledu aplikace." };
  }
  const result = await evaluateProduct(admin as unknown as AdminClient, session.shop, id);
  return {
    message: result
      ? `Produkt odpovídá ${result.matched} kolekcím, nově přidán do ${result.added}.`
      : "Produkt nenalezen.",
  };
};

export default function Run() {
  const { type, title } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const running = useNavigation().state === "submitting";
  const what = type === "Collection" ? "kolekci" : "produkt";

  return (
    <s-page heading={`Zařadit podle pravidel: ${title}`}>
      <s-section>
        {result ? (
          <s-banner tone="success">{result.message}</s-banner>
        ) : (
          <Form method="post">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                {type === "Collection"
                  ? "Projde všechny produkty a přidá do této kolekce ty, které splňují pravidla."
                  : "Porovná produkt se všemi kolekcemi s pravidly a přidá ho do těch, které sedí."}
              </s-paragraph>
              <s-button type="submit" variant="primary" {...(running ? { loading: true } : {})}>
                Vyhodnotit {what}
              </s-button>
            </s-stack>
          </Form>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
