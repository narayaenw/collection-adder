import { gql, type AdminClient } from "./shopify/api.server";

const TITLES_QUERY = `#graphql
  query JobTargets($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id title }
      ... on Collection { id title }
    }
  }`;

/** The product or collection a job works on, taken from its payload. */
export function jobTarget(payload: unknown): string | null {
  const p = (payload ?? {}) as { productId?: unknown; collectionId?: unknown };
  const id = p.productId ?? p.collectionId;
  return typeof id === "string" ? id : null;
}

/** Admin link for a product or collection GID, e.g. shopify://admin/products/123. */
export function adminUrl(gid: string): string | null {
  const match = /^gid:\/\/shopify\/(Product|Collection)\/(\d+)$/.exec(gid);
  if (!match) return null;
  return `shopify://admin/${match[1] === "Product" ? "products" : "collections"}/${match[2]}`;
}

export async function loadTitles(admin: AdminClient, ids: string[]): Promise<Map<string, string>> {
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
