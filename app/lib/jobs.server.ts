/* eslint-disable @typescript-eslint/no-explicit-any -- Shopify GraphQL responses are untyped JSON. */
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { syncAllCollections, syncCollection, loadRuleCollections } from "./collections.server";
import { evaluateProduct } from "./evaluate.server";
import { enqueueJob, type JobType } from "./queue.server";
import { createMatcher } from "./rules/engine";
import { getRules } from "./settings.server";
import { assertNoUserErrors, chunk, gql, runBulkQuery, type AdminClient } from "./shopify/api.server";
import { COLLECTION_ADD_PRODUCTS, parseProductRows, productsBulkQuery } from "./shopify/queries";

type Payload = Record<string, any>;

async function adminFor(shop: string): Promise<AdminClient> {
  const { admin } = await unauthenticated.admin(shop);
  return admin as unknown as AdminClient;
}

async function addProducts(admin: AdminClient, collectionId: string, productIds: string[]) {
  for (const ids of chunk(productIds, 250)) {
    const data = await gql(admin, COLLECTION_ADD_PRODUCTS, { id: collectionId, productIds: ids });
    assertNoUserErrors("collectionAddProductsV2", data.collectionAddProductsV2.userErrors);
  }
}

/** Reads all products once and returns, per collection, the products that should be added. */
async function planAdditions(admin: AdminClient, shop: string, collectionIds?: Set<string>) {
  const rules = await getRules(shop);
  let collections = await loadRuleCollections(shop);
  if (collectionIds) collections = collections.filter((c) => collectionIds.has(c.id));
  const { products, memberships } = parseProductRows(
    await runBulkQuery(admin, productsBulkQuery(rules)),
    rules,
  );

  const match = createMatcher(collections, rules);
  const additions = new Map<string, string[]>();
  for (const product of products) {
    const current = memberships.get(product.id);
    for (const collectionId of match(product)) {
      if (current?.has(collectionId)) continue;
      const list = additions.get(collectionId);
      if (list) list.push(product.id);
      else additions.set(collectionId, [product.id]);
    }
  }
  return { additions, productCount: products.length, collectionCount: collections.length };
}

const handlers: Record<JobType, (shop: string, payload: Payload) => Promise<string>> = {
  async "sync-collections"(shop) {
    const admin = await adminFor(shop);
    const result = await syncAllCollections(admin, shop, await getRules(shop));
    return `Načteno ${result.synced} kolekcí s pravidly z ${result.total}` +
      (result.smartSkipped ? `, přeskočeno ${result.smartSkipped} smart kolekcí` : "") + ".";
  },

  async "sync-collection"(shop, payload) {
    const admin = await adminFor(shop);
    const { synced } = await syncCollection(admin, shop, await getRules(shop), payload.collectionId);
    return synced ? "Kolekce aktualizována." : "Kolekce nemá pravidla, odebrána z přehledu.";
  },

  async "evaluate-product"(shop, payload) {
    const admin = await adminFor(shop);
    const result = await evaluateProduct(admin, shop, payload.productId);
    if (!result) return "Produkt nenalezen.";
    return `Odpovídá ${result.matched} kolekcím, nově přidán do ${result.added}.`;
  },

  async "evaluate-collection"(shop, payload) {
    const admin = await adminFor(shop);
    const rules = await getRules(shop);
    const { synced } = await syncCollection(admin, shop, rules, payload.collectionId);
    if (!synced) return "Kolekce nemá pravidla (nebo je smart kolekce).";
    const { additions, productCount } = await planAdditions(
      admin,
      shop,
      new Set([payload.collectionId]),
    );
    const toAdd = additions.get(payload.collectionId) ?? [];
    await addProducts(admin, payload.collectionId, toAdd);
    return `Prověřeno ${productCount} produktů, přidáno ${toAdd.length}.`;
  },

  async "evaluate-all"(shop) {
    const admin = await adminFor(shop);
    await syncAllCollections(admin, shop, await getRules(shop));
    const { additions, productCount, collectionCount } = await planAdditions(admin, shop);
    let products = 0;
    for (const [collectionId, productIds] of additions) {
      for (const ids of chunk(productIds, 250)) {
        await enqueueJob(shop, "add-products", { collectionId, productIds: ids });
        products += ids.length;
      }
    }
    return `Prověřeno ${productCount} produktů a ${collectionCount} kolekcí. ` +
      `Naplánováno ${products} přiřazení do ${additions.size} kolekcí.`;
  },

  async "add-products"(shop, payload) {
    const admin = await adminFor(shop);
    await addProducts(admin, payload.collectionId, payload.productIds);
    return `Přidáno ${payload.productIds.length} produktů.`;
  },
};

/** Executes a stored job. Throws on failure so Cloud Tasks retries it. */
export async function runJob(jobId: string) {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job || job.status === "done") return;

  await db.job.update({
    where: { id: jobId },
    data: { status: "running", attempts: { increment: 1 }, message: null },
  });
  try {
    const handler = handlers[job.type as JobType];
    if (!handler) throw new Error(`Unknown job type ${job.type}`);
    const message = await handler(job.shop, job.payload as Payload);
    await db.job.update({ where: { id: jobId }, data: { status: "done", message } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.job.update({ where: { id: jobId }, data: { status: "failed", message: message.slice(0, 2000) } });
    throw error;
  }
}
