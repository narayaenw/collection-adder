/* eslint-disable @typescript-eslint/no-explicit-any -- Shopify GraphQL responses are untyped JSON. */
import db from "../db.server";
import { isParentCollection, isRuleCollection } from "./rules/engine";
import { SUBCOLLECTION_KEY, type CollectionSnapshot, type FieldMap, type RuleSet } from "./rules/types";
import { gql, runBulkQuery, type AdminClient } from "./shopify/api.server";
import { collectionQuery, collectionsBulkQuery, toCollectionSnapshot } from "./shopify/queries";

/**
 * Only manual (custom) collections can be filled by the app. Smart collections manage their own
 * products, so they are skipped even when they carry the YMM marker.
 */
function isEligible(node: Record<string, any>, snapshot: CollectionSnapshot, rules: RuleSet) {
  return !node.ruleSet && isRuleCollection(snapshot, rules);
}

/** Replaces the local copy of all rule collections with fresh data from Shopify. */
export async function syncAllCollections(admin: AdminClient, shop: string, rules: RuleSet) {
  const rows = await runBulkQuery(admin, collectionsBulkQuery(rules));
  let smartSkipped = 0;
  const eligible: CollectionSnapshot[] = [];
  for (const row of rows) {
    const snapshot = toCollectionSnapshot(row, rules);
    if (!isRuleCollection(snapshot, rules)) continue;
    if (row.ruleSet) smartSkipped++;
    else eligible.push(snapshot);
  }

  // Several jobs run this concurrently (and webhooks upsert single rows meanwhile), so the
  // replace is serialized per shop and inserts tolerate rows another writer already added.
  const unique = [...new Map(eligible.map((c) => [c.id, c])).values()];
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"sync-collections:" + shop}))`;
      await tx.ruleCollection.deleteMany({ where: { shop } });
      for (let i = 0; i < unique.length; i += 1000) {
        await tx.ruleCollection.createMany({
          skipDuplicates: true,
          data: unique.slice(i, i + 1000).map((c) => ({
            id: c.id,
            shop,
            title: c.title ?? "",
            fields: c.fields as object,
          })),
        });
      }
    },
    { timeout: 120000 },
  );

  return { total: rows.length, synced: unique.length, smartSkipped };
}

/** Refreshes one collection after a collection webhook. */
export async function syncCollection(admin: AdminClient, shop: string, rules: RuleSet, id: string) {
  const data = await gql(admin, collectionQuery(rules), { id });
  const node = data.collection;
  if (!node) {
    await db.ruleCollection.deleteMany({ where: { id, shop } });
    return { synced: false, parent: false };
  }
  const snapshot = toCollectionSnapshot(node, rules);
  if (!isEligible(node, snapshot, rules)) {
    await db.ruleCollection.deleteMany({ where: { id, shop } });
    return { synced: false, parent: false };
  }
  await db.ruleCollection.upsert({
    where: { id },
    create: { id, shop, title: snapshot.title ?? "", fields: snapshot.fields as object },
    update: { title: snapshot.title ?? "", fields: snapshot.fields as object },
  });
  // Parents stay in the local copy for sorting and the matching-rules report.
  return { synced: true, parent: isParentCollection(snapshot) };
}

/** All rule collections in the local copy, parents included (sorting and the report). */
export async function loadAllRuleCollections(shop: string): Promise<CollectionSnapshot[]> {
  const rows = await db.ruleCollection.findMany({
    where: { shop },
    select: { id: true, title: true, fields: true },
  });
  return rows.map((r) => ({ id: r.id, title: r.title, fields: r.fields as FieldMap }));
}

/** The rule collections the app fills and cleans: everything except parents. */
export async function loadRuleCollections(shop: string): Promise<CollectionSnapshot[]> {
  return (await loadAllRuleCollections(shop)).filter((c) => !isParentCollection(c));
}

/** One rule collection from the local copy, or null when it is not there. */
export async function loadRuleCollection(shop: string, id: string): Promise<CollectionSnapshot | null> {
  const row = await db.ruleCollection.findFirst({ where: { shop, id }, select: { id: true, title: true, fields: true } });
  return row && { id: row.id, title: row.title, fields: row.fields as FieldMap };
}

/** Parent collections in the local copy, skipped by filling and removal. Counted in SQL to stay cheap. */
export async function countParentCollections(shop: string): Promise<number> {
  const [row] = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count FROM "RuleCollection"
    WHERE shop = ${shop}
      AND COALESCE(NULLIF(TRIM(fields ->> ${SUBCOLLECTION_KEY}), ''), '[]') <> '[]'`;
  return Number(row?.count ?? 0);
}
