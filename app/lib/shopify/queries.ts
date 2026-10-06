/* eslint-disable @typescript-eslint/no-explicit-any -- Shopify GraphQL responses are untyped JSON. */
import {
  collectionMetafieldKeys,
  productMetafieldKeys,
} from "../rules/engine";
import type { CollectionSnapshot, FieldMap, ProductSnapshot, RuleSet } from "../rules/types";

/** Aliased single-metafield selections (m0, m1, ...) so bulk rows stay flat. */
export function metafieldSelections(keys: string[]): string {
  return keys
    .map((full, i) => {
      const dot = full.indexOf(".");
      const namespace = full.slice(0, dot);
      const key = full.slice(dot + 1);
      return `m${i}: metafield(namespace: ${JSON.stringify(namespace)}, key: ${JSON.stringify(key)}) { value }`;
    })
    .join("\n");
}

export function readMetafields(node: Record<string, any>, keys: string[]): FieldMap {
  const fields: FieldMap = {};
  keys.forEach((key, i) => {
    fields[key] = node[`m${i}`]?.value ?? null;
  });
  return fields;
}

function productFields(node: Record<string, any>, keys: string[]): FieldMap {
  return {
    vendor: node.vendor ?? null,
    product_type: node.productType ?? null,
    tags: Array.isArray(node.tags) ? JSON.stringify(node.tags) : null,
    ...readMetafields(node, keys),
  };
}

export function toProductSnapshot(node: Record<string, any>, rules: RuleSet): ProductSnapshot {
  return { id: node.id, fields: productFields(node, productMetafieldKeys(rules)) };
}

export function toCollectionSnapshot(node: Record<string, any>, rules: RuleSet): CollectionSnapshot {
  return {
    id: node.id,
    title: node.title ?? "",
    fields: readMetafields(node, collectionMetafieldKeys(rules)),
  };
}

export function collectionsBulkQuery(rules: RuleSet): string {
  return `{
  collections {
    edges {
      node {
        id
        title
        ruleSet { appliedDisjunctively }
        ${metafieldSelections(collectionMetafieldKeys(rules))}
      }
    }
  }
}`;
}

export function collectionQuery(rules: RuleSet): string {
  return `#graphql
  query RuleCollection($id: ID!) {
    collection(id: $id) {
      id
      title
      ruleSet { appliedDisjunctively }
      ${metafieldSelections(collectionMetafieldKeys(rules))}
    }
  }`;
}

/** All products with the fields the rules need and their current collections. */
/** All products with rule fields; withCollections adds each product's current collections. */
export function productsBulkQuery(rules: RuleSet, { withCollections = true } = {}): string {
  return `{
  products {
    edges {
      node {
        id
        vendor
        productType
        tags
        ${metafieldSelections(productMetafieldKeys(rules))}
        ${withCollections ? "collections { edges { node { id } } }" : ""}
      }
    }
  }
}`;
}

export function productQuery(rules: RuleSet): string {
  return `#graphql
  query RuleProduct($id: ID!) {
    product(id: $id) {
      id
      vendor
      productType
      tags
      ${metafieldSelections(productMetafieldKeys(rules))}
    }
  }`;
}

/** Products matching a search query, with the fields the rules need. */
export function productSearchPageQuery(rules: RuleSet): string {
  return `#graphql
  query RuleProductSearch($query: String!, $after: String) {
    products(first: 250, after: $after, query: $query) {
      nodes {
        id
        vendor
        productType
        tags
        ${metafieldSelections(productMetafieldKeys(rules))}
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

export const PRODUCT_COLLECTIONS_QUERY = `#graphql
  query ProductCollections($id: ID!, $after: String) {
    product(id: $id) {
      collections(first: 250, after: $after) {
        nodes { id }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

export const COLLECTION_PRODUCT_IDS = `#graphql
  query CollectionProductIds($id: ID!, $after: String) {
    collection(id: $id) {
      products(first: 250, after: $after) {
        nodes { id vendor }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

export const COLLECTION_ADD_PRODUCTS = `#graphql
  mutation AddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProductsV2(id: $id, productIds: $productIds) {
      job { id }
      userErrors { field message }
    }
  }`;

export const PRODUCT_JOIN_COLLECTIONS = `#graphql
  mutation JoinCollections($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id }
      userErrors { field message }
    }
  }`;

/** Splits bulk product rows into products and each product's current collection ids. */
export function parseProductRows(rows: Iterable<any>, rules: RuleSet) {
  const parser = productRowParser(rules);
  for (const row of rows) parser.add(row);
  return parser;
}

/** Collects products and their collection memberships from bulk rows fed one at a time. */
export function productRowParser(rules: RuleSet) {
  const products: ProductSnapshot[] = [];
  const memberships = new Map<string, Set<string>>();
  const add = (row: any) => {
    if (row.__parentId) {
      if (typeof row.id === "string" && row.id.includes("/Collection/")) {
        let set = memberships.get(row.__parentId);
        if (!set) memberships.set(row.__parentId, (set = new Set()));
        set.add(row.id);
      }
    } else if (typeof row.id === "string" && row.id.includes("/Product/")) {
      products.push(toProductSnapshot(row, rules));
    }
  };
  return { products, memberships, add };
}

/** Accepts a numeric id or a GID and returns the GID. */
export function toGid(type: "Product" | "Collection", id: string): string {
  const trimmed = id.trim();
  if (trimmed.startsWith("gid://")) return trimmed;
  if (!/^\d+$/.test(trimmed)) throw new Error(`Neplatné ID: ${id}`);
  return `gid://shopify/${type}/${trimmed}`;
}

function metafieldSelection(alias: string, full: string): string {
  const dot = full.indexOf(".");
  return `${alias}: metafield(namespace: ${JSON.stringify(full.slice(0, dot))}, key: ${JSON.stringify(full.slice(dot + 1))}) { value }`;
}

/** A collection page with what sorting needs: its car and each product's sort fields. */
export function sortCollectionQuery(collectionKeys: string[], productKeys: string[]): string {
  return `#graphql
  query SortCollection($id: ID!, $after: String) {
    collection(id: $id) {
      id
      sortOrder
      ruleSet { appliedDisjunctively }
      ${collectionKeys.map((key, i) => metafieldSelection(`c${i}`, key)).join("\n")}
      products(first: 250, after: $after) {
        nodes {
          id
          tags
          ${metafieldSelections(productKeys)}
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;
}

export const COLLECTION_SET_MANUAL_SORT = `#graphql
  mutation SetManualSort($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id sortOrder }
      userErrors { field message }
    }
  }`;

export const COLLECTION_REORDER_PRODUCTS = `#graphql
  mutation ReorderProducts($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      job { id done }
      userErrors { field message }
    }
  }`;

export const JOB_STATUS = `#graphql
  query JobStatus($id: ID!) {
    job(id: $id) { id done }
  }`;
