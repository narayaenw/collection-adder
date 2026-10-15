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
export function productsBulkQuery(rules: RuleSet): string {
  return `{
  products {
    edges {
      node {
        id
        vendor
        productType
        tags
        ${metafieldSelections(productMetafieldKeys(rules))}
        collections {
          edges { node { id } }
        }
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

export const PRODUCT_COLLECTIONS_QUERY = `#graphql
  query ProductCollections($id: ID!, $after: String) {
    product(id: $id) {
      collections(first: 250, after: $after) {
        nodes { id }
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
export function parseProductRows(rows: any[], rules: RuleSet) {
  const products: ProductSnapshot[] = [];
  const memberships = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.__parentId) {
      if (typeof row.id === "string" && row.id.includes("/Collection/")) {
        let set = memberships.get(row.__parentId);
        if (!set) memberships.set(row.__parentId, (set = new Set()));
        set.add(row.id);
      }
    } else if (typeof row.id === "string" && row.id.includes("/Product/")) {
      products.push(toProductSnapshot(row, rules));
    }
  }
  return { products, memberships };
}

/** Accepts a numeric id or a GID and returns the GID. */
export function toGid(type: "Product" | "Collection", id: string): string {
  const trimmed = id.trim();
  if (trimmed.startsWith("gid://")) return trimmed;
  if (!/^\d+$/.test(trimmed)) throw new Error(`Neplatné ID: ${id}`);
  return `gid://shopify/${type}/${trimmed}`;
}
