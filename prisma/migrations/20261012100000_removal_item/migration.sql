-- CreateTable
CREATE TABLE "RemovalItem" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "collectionTitle" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "removed" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemovalItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RemovalItem_shop_runId_idx" ON "RemovalItem"("shop", "runId");

-- CreateIndex
CREATE INDEX "RemovalItem_runId_collectionId_idx" ON "RemovalItem"("runId", "collectionId");
