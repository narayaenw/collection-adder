-- CreateTable
CREATE TABLE "ExportFile" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "csv" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExportFile_shop_createdAt_idx" ON "ExportFile"("shop", "createdAt");
