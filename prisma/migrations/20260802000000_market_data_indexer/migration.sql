-- Internal market-data indexer.
--
-- Backs MARKET_DATA_PROVIDER="internal": we ingest swap events ourselves so
-- production never depends on a third-party market feed. DexScreener remains
-- wired up as a development provider behind the same interface.

-- Token: the extra market columns the discovery UI renders.
--
-- These were added to schema.prisma without a migration, so `migrate deploy`
-- would have produced a Token table missing them and every catalogue upsert
-- would have failed at runtime. IF NOT EXISTS keeps this idempotent for any
-- database already patched by hand.
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "dexId"         TEXT;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "priceChange5m" DOUBLE PRECISION;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "priceChange1h" DOUBLE PRECISION;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "priceChange6h" DOUBLE PRECISION;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "txnsBuys24h"   INTEGER;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "txnsSells24h"  INTEGER;
ALTER TABLE "Token" ADD COLUMN IF NOT EXISTS "pairCreatedAt" TIMESTAMP(3);

-- IndexedPool: pools discovered from each DEX factory's creation events.
CREATE TABLE IF NOT EXISTS "IndexedPool" (
  "id"            SERIAL PRIMARY KEY,
  "chainId"       TEXT NOT NULL,
  "dexId"         TEXT NOT NULL,
  "poolAddress"   TEXT NOT NULL,
  "token0"        TEXT NOT NULL,
  "token1"        TEXT NOT NULL,
  "decimals0"     INTEGER NOT NULL,
  "decimals1"     INTEGER NOT NULL,
  "feeTier"       INTEGER,
  "createdBlock"  BIGINT,
  "pairCreatedAt" TIMESTAMP(3),
  "liquidityUsd"  DOUBLE PRECISION,
  "lastSwapAt"    TIMESTAMP(3),
  "lastPrice0"    DOUBLE PRECISION,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "IndexedPool_chainId_poolAddress_key"
  ON "IndexedPool"("chainId", "poolAddress");
CREATE INDEX IF NOT EXISTS "IndexedPool_chainId_dexId_idx" ON "IndexedPool"("chainId", "dexId");
CREATE INDEX IF NOT EXISTS "IndexedPool_chainId_token0_idx" ON "IndexedPool"("chainId", "token0");
CREATE INDEX IF NOT EXISTS "IndexedPool_chainId_token1_idx" ON "IndexedPool"("chainId", "token1");

-- PoolCandle: 5-minute OHLCV buckets.
--
-- Raw swaps are deliberately not persisted. A busy chain emits millions a day
-- and nothing the UI asks needs finer resolution than the 5M column it draws,
-- so ingestion aggregates in memory and writes 288 rows per pool per day.
CREATE TABLE IF NOT EXISTS "PoolCandle" (
  "id"          BIGSERIAL PRIMARY KEY,
  "poolId"      INTEGER NOT NULL,
  "bucketStart" TIMESTAMP(3) NOT NULL,
  "open"        DOUBLE PRECISION NOT NULL,
  "high"        DOUBLE PRECISION NOT NULL,
  "low"         DOUBLE PRECISION NOT NULL,
  "close"       DOUBLE PRECISION NOT NULL,
  "volumeUsd"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "buys"        INTEGER NOT NULL DEFAULT 0,
  "sells"       INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS "PoolCandle_poolId_bucketStart_key"
  ON "PoolCandle"("poolId", "bucketStart");
CREATE INDEX IF NOT EXISTS "PoolCandle_bucketStart_idx" ON "PoolCandle"("bucketStart");
CREATE INDEX IF NOT EXISTS "PoolCandle_poolId_bucketStart_idx"
  ON "PoolCandle"("poolId", "bucketStart");

DO $$
BEGIN
  ALTER TABLE "PoolCandle"
    ADD CONSTRAINT "PoolCandle_poolId_fkey"
    FOREIGN KEY ("poolId") REFERENCES "IndexedPool"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- IndexerCursor: per-chain ingestion progress, so a restart resumes rather
-- than rescanning from genesis.
CREATE TABLE IF NOT EXISTS "IndexerCursor" (
  "chainId"       TEXT PRIMARY KEY,
  "lastBlock"     BIGINT NOT NULL,
  "lastPoolBlock" BIGINT,
  "updatedAt"     TIMESTAMP(3) NOT NULL
);

-- Which side of the pool is the traded token, and which is the priced one.
--
-- The rollup must credit a pool's price to exactly one token. Attributing it to
-- both sides makes the quote asset inherit the inverse of whatever it's paired
-- with — a WETH/memecoin pool reports WETH itself moving hundreds of percent.
ALTER TABLE "IndexedPool" ADD COLUMN IF NOT EXISTS "baseToken"  TEXT;
ALTER TABLE "IndexedPool" ADD COLUMN IF NOT EXISTS "quoteToken" TEXT;

CREATE INDEX IF NOT EXISTS "IndexedPool_chainId_baseToken_idx"
  ON "IndexedPool"("chainId", "baseToken");
