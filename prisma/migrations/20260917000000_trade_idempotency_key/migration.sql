-- Idempotency key for trade execution.
--
-- The BullMQ job id for the trade, recorded so a replayed job can recognise
-- that it already created (and possibly already broadcast) its trade. Nullable
-- for rows that predate the column; the unique index therefore permits many
-- NULLs and exactly one row per key.
ALTER TABLE "Trade" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Trade_idempotencyKey_key" ON "Trade"("idempotencyKey");
