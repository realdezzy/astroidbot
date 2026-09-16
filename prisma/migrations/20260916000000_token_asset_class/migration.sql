-- AlterTable
ALTER TABLE "Token" ADD COLUMN "assetClass" TEXT NOT NULL DEFAULT 'CRYPTO';

-- CreateIndex
CREATE INDEX "Token_assetClass_volume24h_idx" ON "Token"("assetClass", "volume24h");
