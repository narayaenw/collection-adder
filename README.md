# CollectionAdder

Shopify aplikace, která přiřazuje produkty (alu kola) do kolekcí podle pravidel. Hodnoty pro pravidla bere z metapolí kolekce (vozidla) a porovnává je s metapoli produktu (kola).

## Jak funguje

- **Které kolekce:** ruční kolekce s metapolem `custom.ucel = YMM_Cloudflare` (nastavitelné). Smart kolekce se přeskakují, protože do nich nejde přidávat ručně.
- **Pravidla:** jedna sada pro všechny kolekce, upravitelná v *Nastavení pravidel*. Výchozí:

  | Produkt | Podmínka | Kolekce |
  |---|---|---|
  | `custom.pcd` | je rovno některé z hodnot | `custom.ymm_pcd` |
  | `custom.size` | v rozsahu (`16-17` = 16 až 17 včetně) | `custom.ymm_size` |
  | `custom.cb` | větší nebo rovno | `custom.ymm_cb` |
  | `custom.inner_mm` | menší než | `custom.ymm_inner_cb` |
  | `custom.outer_mm` | menší než | `custom.ymm_outer_cb` |
  | vendor | není AEZ, Dotz, Dezent | |

  Chybějící hodnota na kterékoli straně znamená „nesedí“.
- **Lokální kopie kolekcí:** aplikace drží metapole všech YMM kolekcí v Postgresu (načtení přes Bulk Operation, aktualizace přes webhooky `collections/*` a noční synchronizaci). Nový produkt se tak porovná se ~17 000 kolekcemi v paměti bez dotazování Shopify.
- **Spouštění:**
  - automaticky webhookem `products/create` (s odstupem `PRODUCT_CREATE_DELAY_SECONDS`, výchozí 120 s, aby stihla doběhnout metapole),
  - z detailu produktu nebo kolekce v adminu přes *Další akce → Zařadit … podle pravidel*,
  - z přehledu aplikace: vyhodnotit produkt, kolekci, nebo vše.
- **Fronta:** v produkci Cloud Tasks volá `/jobs/run`. Rychlost fronty drží aplikaci pod limity Shopify API, neúspěšné úlohy se opakují. Lokálně běží úlohy postupně v procesu.

Produkty se zatím jen přidávají. Odebírání a reakce na úpravu produktu jsou ve fázi 2.

## Lokální vývoj

```bash
npm install
cp .env.example .env   # doplň DATABASE_URL na lokální Postgres
npx prisma migrate deploy
npm run dev            # Shopify CLI, propojí aplikaci s Partner účtem
npm test
```

## Nasazení na Google Cloud

Předpoklady: projekt v GCP, `gcloud` CLI, aplikace založená v Shopify Partners / Dev Dashboard (Client ID a secret).

```bash
PROJECT=muj-projekt
REGION=europe-west3
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com sqladmin.googleapis.com cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

# 1. Databáze
gcloud sql instances create collection-adder-db --database-version=POSTGRES_16 \
  --tier=db-g1-small --region=$REGION
gcloud sql databases create app --instance=collection-adder-db
gcloud sql users create app --instance=collection-adder-db --password='SILNE_HESLO'

# 2. Fronta úloh (rychlost nastavená s rezervou pod limity Shopify)
gcloud tasks queues create collection-adder --location=$REGION \
  --max-dispatches-per-second=2 --max-concurrent-dispatches=4 \
  --max-attempts=5 --min-backoff=30s

# 3. Aplikace
JOBS_SECRET=$(openssl rand -hex 32)
gcloud run deploy collection-adder --source . --region=$REGION --allow-unauthenticated \
  --add-cloudsql-instances=$PROJECT:$REGION:collection-adder-db \
  --timeout=1800 --memory=2Gi --min-instances=1 \
  --set-env-vars="SHOPIFY_API_KEY=...,SHOPIFY_API_SECRET=...,SCOPES=read_products,write_products" \
  --set-env-vars="DATABASE_URL=postgresql://app:SILNE_HESLO@localhost/app?host=/cloudsql/$PROJECT:$REGION:collection-adder-db" \
  --set-env-vars="GCP_PROJECT=$PROJECT,GCP_LOCATION=$REGION,CLOUD_TASKS_QUEUE=collection-adder,JOBS_SECRET=$JOBS_SECRET"

# Po prvním nasazení doplň URL služby:
URL=$(gcloud run services describe collection-adder --region=$REGION --format='value(status.url)')
gcloud run services update collection-adder --region=$REGION --update-env-vars="SHOPIFY_APP_URL=$URL"

# Účet služby Cloud Run musí smět zakládat úlohy ve frontě:
SA=$(gcloud run services describe collection-adder --region=$REGION --format='value(spec.template.spec.serviceAccountName)')
gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$SA" --role=roles/cloudtasks.enqueuer

# 4. Noční synchronizace kolekcí
gcloud scheduler jobs create http collection-adder-sync --location=$REGION \
  --schedule="0 3 * * *" --time-zone="Europe/Prague" \
  --uri="$URL/jobs/cron" --http-method=POST --headers="X-Jobs-Secret=$JOBS_SECRET"
```

Pak v `shopify.app.toml` nastav `client_id` a `application_url` na `$URL` a spusť `npm run deploy` (nahraje webhooky a odkazy do adminu). Po instalaci v obchodě klikni v aplikaci na **Synchronizovat kolekce** a potom **Vyhodnotit vše**.

Proměnné prostředí shrnuje [.env.example](.env.example).
