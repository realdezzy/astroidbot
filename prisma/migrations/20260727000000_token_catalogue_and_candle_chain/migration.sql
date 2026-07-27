-- Candle: scope by chain (fixes a silent cross-chain data collision).
--
-- Candle.token held a bare symbol under UNIQUE(token, timeframe, timestamp).
-- Once a second chain is enabled, "USDC" on Base and "USDC" on Stacks — two
-- different assets at different prices — map to the same row, and each write
-- overwrites the other. Nothing errors; the series just becomes meaningless.
-- Existing rows are all Stacks, so they backfill to stacks:mainnet.

ALTER TABLE "Candle" ADD COLUMN IF NOT EXISTS "chainId" TEXT NOT NULL DEFAULT 'stacks:mainnet';

DROP INDEX IF EXISTS "Candle_token_timeframe_timestamp_key";
DROP INDEX IF EXISTS "Candle_token_timeframe_timestamp_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "Candle_chainId_token_timeframe_timestamp_key"
  ON "Candle"("chainId", "token", "timeframe", "timestamp");
CREATE INDEX IF NOT EXISTS "Candle_chainId_token_timeframe_timestamp_idx"
  ON "Candle"("chainId", "token", "timeframe", "timestamp");

-- Token: cross-chain catalogue backing public discovery.
CREATE TABLE IF NOT EXISTS "Token" (
  "id"             SERIAL PRIMARY KEY,
  "chainId"        TEXT NOT NULL,
  "contractId"     TEXT NOT NULL,
  "symbol"         TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "decimals"       INTEGER NOT NULL,
  "logoUrl"        TEXT,
  "priceUsd"       DOUBLE PRECISION,
  "priceChange24h" DOUBLE PRECISION,
  "volume24h"      DOUBLE PRECISION,
  "liquidityUsd"   DOUBLE PRECISION,
  "marketCapUsd"   DOUBLE PRECISION,
  "isVerified"     BOOLEAN NOT NULL DEFAULT false,
  "lastSyncedAt"   TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "Token_chainId_contractId_key" ON "Token"("chainId", "contractId");
CREATE INDEX IF NOT EXISTS "Token_chainId_volume24h_idx" ON "Token"("chainId", "volume24h");
CREATE INDEX IF NOT EXISTS "Token_symbol_idx" ON "Token"("symbol");
