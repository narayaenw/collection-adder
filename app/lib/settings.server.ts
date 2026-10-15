import db from "../db.server";
import { parseRuleSet } from "./rules/engine";
import { DEFAULT_RULE_SET, type RuleSet } from "./rules/types";

export async function getRules(shop: string): Promise<RuleSet> {
  const row = await db.settings.findUnique({ where: { shop } });
  if (!row) return DEFAULT_RULE_SET;
  const { rules } = parseRuleSet(row.rules);
  return rules ?? DEFAULT_RULE_SET;
}

export async function saveRules(shop: string, rules: RuleSet) {
  await db.settings.upsert({
    where: { shop },
    create: { shop, rules: rules as object },
    update: { rules: rules as object },
  });
}
