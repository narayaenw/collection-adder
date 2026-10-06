/* eslint-disable @typescript-eslint/no-explicit-any -- Shopify GraphQL responses are untyped JSON. */
import db from "../db.server";
import { isRuleCollection } from "./rules/engine";
import type { CollectionSnapshot, FieldMap, RuleSet } from "./rules/types";
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

  await db.$transaction(
    async (tx) => {
      await tx.ruleCollection.deleteMany({ where: { shop } });
      for (let i = 0; i < eligible.length; i += 1000) {
        await tx.ruleCollection.createMany({
          data: eligible.slice(i, i + 1000).map((c) => ({
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

  return { total: rows.length, synced: eligible.length, smartSkipped };
}

/** Refreshes one collection after a collection webhook. */
export async function syncCollection(admin: AdminClient, shop: string, rules: RuleSet, id: string) {
  const data = await gql(admin, collectionQuery(rules), { id });
  const node = data.collection;
  if (!node) {
    await db.ruleCollection.deleteMany({ where: { id, shop } });
    return { synced: false };
  }
  const snapshot = toCollectionSnapshot(node, rules);
  if (!isEligible(node, snapshot, rules)) {
    await db.ruleCollection.deleteMany({ where: { id, shop } });
    return { synced: false };
  }
  await db.ruleCollection.upsert({
    where: { id },
    create: { id, shop, title: snapshot.title ?? "", fields: snapshot.fields as object },
    update: { title: snapshot.title ?? "", fields: snapshot.fields as object },
  });
  return { synced: true };
}

export async function loadRuleCollections(shop: string): Promise<CollectionSnapshot[]> {
  const rows = await db.ruleCollection.findMany({
    where: { shop },
    select: { id: true, title: true, fields: true },
  });
  return rows.map((r) => ({ id: r.id, title: r.title, fields: r.fields as FieldMap }));
}
