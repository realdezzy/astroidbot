-- Raw swaps, so candle aggregation becomes idempotent.
--
-- Candle volume accumulated additively, which made ingesting a range twice
-- inflate it permanently and undetectably. Almost every defensive mechanism in
-- the indexer exists to prevent that one thing: the cross-process Redis lock,
-- the transaction-wrapped cursor, the refusal to step over an unreadable gap,
-- the careful backfill seeding, and the migration marking pre-existing chains
-- complete.
--
-- With the swaps themselves stored under their on-chain identity, a replay
-- inserts nothing and candles are recomputed from storage rather than added
-- to. Re-processing is free, and a reorg can be repaired by deleting the
-- affected swaps and recomputing — impossible before, because addition has no
-- inverse.
CREATE TABLE IF NOT EXISTS "IndexedSwap" (
  "id"          SERIAL PRIMARY KEY,
  "poolId"      INTEGER NOT NULL REFERENCES "IndexedPool"("id") ON DELETE CASCADE,
  "txKey"       TEXT NOT NULL,
  "blockNumber" BIGINT NOT NULL,
  "logIndex"    INTEGER NOT NULL DEFAULT 0,
  "bucketStart" TIMESTAMP(3) NOT NULL,
  "priceUsd"    DOUBLE PRECISION NOT NULL,
  "volumeUsd"   DOUBLE PRECISION NOT NULL,
  "isBuy"       BOOLEAN NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "IndexedSwap_poolId_txKey_key"
  ON "IndexedSwap"("poolId", "txKey");
CREATE INDEX IF NOT EXISTS "IndexedSwap_poolId_bucketStart_idx"
  ON "IndexedSwap"("poolId", "bucketStart");
CREATE INDEX IF NOT EXISTS "IndexedSwap_bucketStart_idx"
  ON "IndexedSwap"("bucketStart");

-- Existing candles are left alone. They were computed additively from swaps
-- that were never stored, so they cannot be recomputed — and discarding them
-- would blank every discovery page until a day's worth of history rebuilt.
-- They age out through normal retention; everything ingested from here is
-- recomputed rather than accumulated.
