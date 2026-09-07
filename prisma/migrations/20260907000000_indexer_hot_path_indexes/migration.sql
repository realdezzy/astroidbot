-- Indexes for the queries the indexer and discovery pages run on every tick
-- and every request, plus removal of one that was doing no work.
--
-- CONCURRENTLY is deliberately NOT used: Prisma runs each migration inside a
-- transaction and CREATE INDEX CONCURRENTLY cannot run in one. These tables
-- are written only by the indexer process, which tolerates a brief lock, and
-- the alternative — a hand-run migration outside the migration history — is
-- how a schema and its record of itself drift apart.

-- trackedPools(): a chain's pools, most recently active first, capped. Runs
-- once per chain per tick and was a scan-and-sort of every pool on the chain.
CREATE INDEX IF NOT EXISTS "IndexedPool_chainId_lastSwapAt_idx"
  ON "IndexedPool" ("chainId", "lastSwapAt");

-- The Solana downward walk: pools still owing history, deepest first.
CREATE INDEX IF NOT EXISTS "IndexedPool_chainId_backfillDone_liquidityUsd_idx"
  ON "IndexedPool" ("chainId", "backfillDone", "liquidityUsd");

-- The recent-trades feed orders by on-chain position. [poolId, bucketStart]
-- cannot serve that: a five-minute bucket does not order the swaps inside it.
CREATE INDEX IF NOT EXISTS "IndexedSwap_poolId_blockNumber_logIndex_idx"
  ON "IndexedSwap" ("poolId", "blockNumber", "logIndex");

-- Redundant with the unique constraint "PoolCandle_poolId_bucketStart_key",
-- which is a btree over the same columns in the same order. Two identical
-- indexes on the table every ingestion pass upserts into, for no read the
-- constraint could not already satisfy.
DROP INDEX IF EXISTS "PoolCandle_poolId_bucketStart_idx";
