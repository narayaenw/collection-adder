import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { enqueueJob } from "../lib/queue.server";
import { collectionMetafieldKeys, parseRuleSet } from "../lib/rules/engine";
import { DEFAULT_RULE_SET, OPERATORS, OPERATOR_LABELS, type Condition } from "../lib/rules/types";
import { getRules, saveRules } from "../lib/settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { rules: await getRules(session.shop), defaults: DEFAULT_RULE_SET };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const all = (name: string) => form.getAll(name).map((v) => String(v));

  const productFields = all("productField");
  const operators = all("operator");
  const sourceTypes = all("sourceType");
  const sourceValues = all("sourceValue");

  const input = {
    collectionFilter: { key: form.get("filterKey"), value: form.get("filterValue") },
    conditions: productFields.map((productField, i) => ({
      productField,
      operator: operators[i],
      source:
        sourceTypes[i] === "value"
          ? { type: "value", value: sourceValues[i] }
          : { type: "collection", key: sourceValues[i] },
    })),
    excludedVendors: String(form.get("excludedVendors") ?? "").split(/\r?\n|,/),
  };

  const { rules, errors } = parseRuleSet(input);
  if (!rules) return { ok: false, errors };

  const previous = await getRules(shop);
  await saveRules(shop, rules);

  // The local copy only holds the collection metafields the old rules used, so it is re-read
  // whenever the rules start using other ones.
  const before = collectionMetafieldKeys(previous).sort().join(",");
  const after = collectionMetafieldKeys(rules).sort().join(",");
  const resync = before !== after || previous.collectionFilter.value !== rules.collectionFilter.value;
  if (resync) await enqueueJob(shop, "sync-collections");

  return { ok: true, errors: [], resync };
};

interface Row {
  key: number;
  condition: Condition;
}

let nextKey = 0;
const toRows = (conditions: Condition[]): Row[] =>
  conditions.map((condition) => ({ key: nextKey++, condition }));

export default function Settings() {
  const { rules, defaults } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const [rows, setRows] = useState<Row[]>(() => toRows(rules.conditions as Condition[]));
  const [formKey, setFormKey] = useState(0);
  const saving = navigation.state === "submitting";

  useEffect(() => {
    if (result?.ok) {
      shopify.toast.show(
        result.resync ? "Uloženo. Kolekce se znovu načítají." : "Pravidla uložena.",
      );
    }
  }, [result, shopify]);

  const addRow = () =>
    setRows((current) => [
      ...current,
      {
        key: nextKey++,
        condition: { productField: "", operator: "eq", source: { type: "collection", key: "" } },
      },
    ]);
  const removeRow = (key: number) => setRows((current) => current.filter((r) => r.key !== key));
  const resetToDefaults = () => {
    setRows(toRows(defaults.conditions as Condition[]));
    setFormKey((k) => k + 1);
  };

  const shown = formKey === 0 ? rules : defaults;

  return (
    <s-page heading="Nastavení pravidel">
      <Form method="post" key={formKey}>
        {result && !result.ok && (
          <s-banner tone="critical" heading="Pravidla nejsou platná">
            <s-unordered-list>
              {result.errors.map((error) => (
                <s-list-item key={error}>{error}</s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        )}

        <s-section heading="Které kolekce">
          <s-paragraph>
            Pravidla se použijí na ruční kolekce, jejichž metapole má danou hodnotu.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-text-field
              name="filterKey"
              label="Metapole kolekce"
              value={shown.collectionFilter.key}
              placeholder="custom.ucel"
            />
            <s-text-field
              name="filterValue"
              label="Hodnota"
              value={shown.collectionFilter.value}
              placeholder="YMM_Cloudflare"
            />
          </s-stack>
        </s-section>

        <s-section heading="Podmínky (musí platit všechny)">
          <s-paragraph>
            Pole produktu je metapole ve tvaru namespace.key (např. custom.pcd), nebo vendor,
            product_type, tags. Seznamové hodnoty stačí, když se shoduje kterákoli z nich.
          </s-paragraph>
          <s-stack direction="block" gap="base">
            {rows.map(({ key, condition }) => (
              <s-stack key={key} direction="inline" gap="base" alignItems="end">
                <s-text-field
                  name="productField"
                  label="Pole produktu"
                  value={condition.productField}
                  placeholder="custom.pcd"
                />
                <s-select name="operator" label="Podmínka" value={condition.operator}>
                  {OPERATORS.map((op) => (
                    <s-option key={op} value={op}>
                      {OPERATOR_LABELS[op]}
                    </s-option>
                  ))}
                </s-select>
                <s-select name="sourceType" label="Porovnat s" value={condition.source.type}>
                  <s-option value="collection">metapolem kolekce</s-option>
                  <s-option value="value">pevnou hodnotou</s-option>
                </s-select>
                <s-text-field
                  name="sourceValue"
                  label="Metapole kolekce / hodnota"
                  value={
                    condition.source.type === "collection"
                      ? condition.source.key
                      : condition.source.value
                  }
                  placeholder="custom.ymm_pcd"
                />
                <s-button
                  type="button"
                  variant="tertiary"
                  tone="critical"
                  onClick={() => removeRow(key)}
                >
                  Odebrat
                </s-button>
              </s-stack>
            ))}
            <s-stack direction="inline" gap="base">
              <s-button type="button" onClick={addRow}>
                Přidat podmínku
              </s-button>
              <s-button type="button" variant="tertiary" onClick={resetToDefaults}>
                Obnovit výchozí pravidla
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading="Vyloučení výrobci">
          <s-text-area
            name="excludedVendors"
            label="Produkty těchto výrobců se nikdy nepřidají (jeden na řádek)"
            value={shown.excludedVendors.join("\n")}
            rows={4}
          />
        </s-section>

        <s-section>
          <s-button type="submit" variant="primary" {...(saving ? { loading: true } : {})}>
            Uložit pravidla
          </s-button>
        </s-section>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
