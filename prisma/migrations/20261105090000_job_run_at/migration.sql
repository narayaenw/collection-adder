-- AlterTable
ALTER TABLE "Job" ADD COLUMN "runAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Job_shop_status_runAt_idx" ON "Job"("shop", "status", "runAt");
