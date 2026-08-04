-- Split the indexer's token table from the backend's catalogue.
--
-- One table, "Token", was written by both processes: the backend catalogued
-- what its DEX providers could route, and the indexer created rows for tokens
-- it saw trade and then wrote metrics onto them. With ingestion moved into its
-- own container that became two processes upserting the same rows, where a
-- row's identity and its metrics could come from different passes and nothing
-- downstream could tell which.
--
-- After this: the indexer writes "IndexedToken" and only that; the backend
-- writes "Token" and only that, reading IndexedToken through the
-- MarketDataProvider interface.

CREATE TABLE IF NOT EXISTS "IndexedToken" (
  "id"             SERIAL PRIMARY KEY,
  "chainId"        TEXT NOT NULL,
  "contractId"     TEXT NOT NULL,
  "symbol"         TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "decimals"       INTEGER NOT NULL,
  "dexId"          TEXT,
  "priceUsd"       DOUBLE PRECISION,
  "priceChange5m"  DOUBLE PRECISION,
  "priceChange1h"  DOUBLE PRECISION,
  "priceChange6h"  DOUBLE PRECISION,
  "priceChange24h" DOUBLE PRECISION,
  "volume24h"      DOUBLE PRECISION,
  "liquidityUsd"   DOUBLE PRECISION,
  "marketCapUsd"   DOUBLE PRECISION,
  "txnsBuys24h"    INTEGER,
  "txnsSells24h"   INTEGER,
  "pairCreatedAt"  TIMESTAMP(3),
  "lastRolledUpAt" TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "IndexedToken_chainId_contractId_key"
  ON "IndexedToken"("chainId", "contractId");
CREATE INDEX IF NOT EXISTS "IndexedToken_chainId_volume24h_idx"
  ON "IndexedToken"("chainId", "volume24h");
CREATE INDEX IF NOT EXISTS "IndexedToken_symbol_idx"
  ON "IndexedToken"("symbol");

-- Seed from what the indexer already wrote into Token.
--
-- Only rows carrying observed metrics are copied. A catalogue row with no
-- volume, liquidity or transaction counts was never touched by a rollup — it
-- came from a DEX provider list — and copying it would fabricate an
-- observation the indexer never made. Those rows stay where they belong, and
-- the next ingestion pass creates an IndexedToken for any of them that
-- actually trades.
--
-- lastRolledUpAt is seeded from lastSyncedAt: on a row with metrics, that
-- timestamp came from a rollup write. It gates promotion back into the
-- catalogue, so leaving it null would make every pre-existing token look
-- unrolled.
INSERT INTO "IndexedToken" (
  "chainId", "contractId", "symbol", "name", "decimals", "dexId",
  "priceUsd", "priceChange5m", "priceChange1h", "priceChange6h", "priceChange24h",
  "volume24h", "liquidityUsd", "marketCapUsd", "txnsBuys24h", "txnsSells24h",
  "pairCreatedAt", "lastRolledUpAt", "createdAt", "updatedAt"
)
SELECT
  "chainId", "contractId", "symbol", "name", "decimals", "dexId",
  "priceUsd", "priceChange5m", "priceChange1h", "priceChange6h", "priceChange24h",
  "volume24h", "liquidityUsd", "marketCapUsd", "txnsBuys24h", "txnsSells24h",
  "pairCreatedAt", "lastSyncedAt", "createdAt", CURRENT_TIMESTAMP
FROM "Token"
WHERE "volume24h" IS NOT NULL
   OR "liquidityUsd" IS NOT NULL
   OR "txnsBuys24h" IS NOT NULL
   OR "txnsSells24h" IS NOT NULL
ON CONFLICT ("chainId", "contractId") DO NOTHING;

-- Token keeps its market columns. They are now a cache of IndexedToken,
-- refreshed by the backend's own discovery sync, so that the discovery page
-- stays one indexed scan over one table — and so that chains with no indexer
-- (Stacks, Solana) still have somewhere to put a price.
