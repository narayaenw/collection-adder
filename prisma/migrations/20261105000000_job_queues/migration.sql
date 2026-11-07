-- AlterTable
ALTER TABLE "Job" ADD COLUMN "dedupKey" TEXT;

-- CreateIndex
CREATE INDEX "Job_shop_dedupKey_status_idx" ON "Job"("shop", "dedupKey", "status");

-- Sorting was removed from the app: its nightly change records are no longer read.
DELETE FROM "ProductState" WHERE "kind" = 'sort';
DELETE FROM "CollectionCheck" WHERE "kind" = 'sort';
