ALTER TABLE "IndexedPool" ADD COLUMN "lastPolledAt" TIMESTAMP(3);
ALTER TABLE "IndexerCursor" ADD COLUMN "forwardState" JSONB;
CREATE INDEX "IndexedPool_chainId_lastPolledAt_idx" ON "IndexedPool"("chainId", "lastPolledAt");
-- Rebuild factory coverage on existing EVM chains. Swap identities make replay safe.
UPDATE "IndexerCursor" SET "lastPoolBlock" = NULL, "backfillBlock" = "lastBlock" + 1, "backfillFloor" = NULL, "backfillDone" = false
WHERE "chainId" NOT LIKE 'stacks:%' AND "chainId" NOT LIKE 'solana:%';

ALTER TABLE "IndexedPool" ADD COLUMN "forwardBefore" TEXT, ADD COLUMN "forwardHead" TEXT;
ALTER TABLE "IndexedPool" ADD COLUMN "programId" TEXT, ADD COLUMN "vault0" TEXT, ADD COLUMN "vault1" TEXT;
ALTER TABLE "IndexedPool" ADD COLUMN "indexingError" TEXT;
UPDATE "IndexerCursor" SET "backfillDone" = false WHERE "chainId" LIKE 'stacks:%';
ALTER TABLE "IndexedPool" ADD COLUMN "protocolState" JSONB;
ALTER TABLE "IndexedPool" ADD COLUMN "forwardTargetBlock" BIGINT, ADD COLUMN "lastIndexedBlock" BIGINT;
