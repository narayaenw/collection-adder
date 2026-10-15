import db from "../db.server";
import {
  checkHash,
  collectionsAffectedByProducts,
  isStale,
  pickFields,
  productKeysFor,
  type CheckKind,
} from "./rules/changes";
import { PRODUCT_BUILTIN_FIELDS, type CollectionSnapshot, type FieldMap, type ProductSnapshot, type RuleSet } from "./rules/types";
import { forEachBulkRow, type AdminClient } from "./shopify/api.server";
import { productFieldsBulkQuery, readMetafields } from "./shopify/queries";

/** Product fields kept between nightly passes: everything either pass reads. */
function storedKeys(rules: RuleSet): string[] {
  return [...new Set([...productKeysFor("clean", rules), ...productKeysFor("sort", rules)])];
}

/** All products with the fields the nightly passes read, from one bulk export. */
async function exportProductFields(admin: AdminClient, rules: RuleSet): Promise<ProductSnapshot[]> {
  const keys = storedKeys(rules);
  const metafieldKeys = keys.filter((k) => !PRODUCT_BUILTIN_FIELDS.includes(k));
  const products: ProductSnapshot[] = [];
  await forEachBulkRow(admin, productFieldsBulkQuery(metafieldKeys), (row) => {
    if (row.__parentId || typeof row.id !== "string" || !row.id.includes("/Product/")) return;
    const fields: FieldMap = {
      vendor: row.vendor ?? null,
      product_type: row.productType ?? null,
      tags: Array.isArray(row.tags) ? JSON.stringify(row.tags) : null,
      ...readMetafields(row, metafieldKeys),
    };
    products.push({ id: row.id, fields: pickFields(fields, keys) });
  });
  return products;
}

/**
 * Picks the rule collections a nightly pass has to visit: never checked, checked with other
 * collection metafields or settings, not checked for a week or so, or holding products whose
 * fields changed since the last pass. Their earlier checks are dropped here, before their jobs
 * are queued. Call `save` once the jobs are queued, so the next pass compares products with what
 * this one saw.
 */
export async function planChangedCollections(
  admin: AdminClient,
  shop: string,
  kind: CheckKind,
  rules: RuleSet,
  collections: CollectionSnapshot[],
) {
  const now = new Date();
  const checks = new Map(
    (await db.collectionCheck.findMany({ where: { shop, kind }, select: { collectionId: true, hash: true, checkedAt: true } }))
      .map((c) => [c.collectionId, c]),
  );
  const selected = new Set<string>();
  for (const c of collections) {
    const check = checks.get(c.id);
    if (!check || check.hash !== checkHash(kind, rules, c.fields) || isStale(c.id, check.checkedAt, now)) {
      selected.add(c.id);
    }
  }
  const unchangedCollections = collections.length - selected.size;

  const products = await exportProductFields(admin, rules);
  const previous = new Map(
    (await db.productState.findMany({ where: { shop, kind }, select: { productId: true, fields: true } }))
      .map((p) => [p.productId, p.fields as FieldMap]),
  );
  let changedProducts = products.length;
  if (previous.size > 0) {
    const affected = collectionsAffectedByProducts(kind, rules, collections, previous, products);
    changedProducts = affected.changedProducts;
    for (const id of affected.collectionIds) selected.add(id);
  } else {
    // No earlier pass to compare with: visit everything.
    for (const c of collections) selected.add(c.id);
  }

  // Until its job succeeds and records a fresh check, a selected collection stays selected, so
  // a purged queue or a job that keeps failing does not lose the change it was selected for.
  const collectionIds = collections.filter((c) => selected.has(c.id)).map((c) => c.id);
  for (let i = 0; i < collectionIds.length; i += 1000) {
    await db.collectionCheck.deleteMany({
      where: { shop, kind, collectionId: { in: collectionIds.slice(i, i + 1000) } },
    });
  }

  const save = async () => {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`product-state:${kind}:${shop}`}))`;
        await tx.productState.deleteMany({ where: { shop, kind } });
        for (let i = 0; i < products.length; i += 1000) {
          await tx.productState.createMany({
            skipDuplicates: true,
            data: products.slice(i, i + 1000).map((p) => ({
              id: `${kind}:${p.id}`,
              shop,
              kind,
              productId: p.id,
              fields: p.fields as object,
            })),
          });
        }
      },
      { timeout: 120000 },
    );
  };

  return {
    collectionIds,
    unchangedCollections,
    changedProducts,
    save,
  };
}

/** Notes that a pass went through a collection, with what the collection looked like then. */
export async function recordCheck(
  shop: string,
  kind: CheckKind,
  rules: RuleSet,
  collectionId: string,
  checkedAt: Date,
) {
  const row = await db.ruleCollection.findFirst({ where: { shop, id: collectionId }, select: { fields: true } });
  if (!row) return;
  const hash = checkHash(kind, rules, row.fields as FieldMap);
  await db.collectionCheck.upsert({
    where: { id: `${kind}:${collectionId}` },
    create: { id: `${kind}:${collectionId}`, shop, kind, collectionId, hash, checkedAt },
    update: { hash, checkedAt },
  });
}

/** Job result suffix telling how much a nightly pass skipped. */
export function skippedSummary(plan: { collectionIds: string[]; changedProducts: number }, total: number) {
  return ` (${total - plan.collectionIds.length} z ${total} kolekcí beze změny přeskočeno, ` +
    `změněných produktů ${plan.changedProducts}).`;
}
