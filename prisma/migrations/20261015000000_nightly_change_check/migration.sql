-- CreateTable
CREATE TABLE "CollectionCheck" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductState" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fields" JSONB NOT NULL,

    CONSTRAINT "ProductState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CollectionCheck_shop_kind_idx" ON "CollectionCheck"("shop", "kind");

-- CreateIndex
CREATE INDEX "ProductState_shop_kind_idx" ON "ProductState"("shop", "kind");
