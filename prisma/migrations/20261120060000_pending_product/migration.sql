-- CreateTable
CREATE TABLE "PendingProduct" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingProduct_shop_createdAt_idx" ON "PendingProduct"("shop", "createdAt");
