-- Multi-chain wallet support, plus a catch-up for schema drift.
--
-- Before this, deploys ran `prisma db push` (see docker-entrypoint.sh), so
-- schema changes made over time were never recorded as migrations and the
-- checked-in init migration fell behind the live database. This migration is
-- the generated diff between init and the current schema.prisma, so it carries
-- both the new multi-chain columns and everything push applied in between:
--
--   * Wallet.chainFamily / Wallet.chain, and the unique key moving from
--     (address) to (chainFamily, address) — an address is only unique within
--     a chain family. Existing rows default to stacks / stacks:mainnet.
--   * Tables added via push and never migrated: ContactMessage, Notification,
--     Candle, PoolStatsHistory.
--   * failureCount columns on LimitOrder, TradeAgent, TradingStrategy.
--
-- Databases already carrying this schema (anything provisioned by db push)
-- must be baselined rather than run through it:
--   npx prisma migrate resolve --applied 20250620000000_init
--   npx prisma migrate resolve --applied 20260726120000_multichain_wallets_and_catchup

-- DropIndex
DROP INDEX "Wallet_address_key";

-- AlterTable
ALTER TABLE "LimitOrder" ADD COLUMN     "failureCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TradeAgent" ADD COLUMN     "failureCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TradingStrategy" ADD COLUMN     "failureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "state" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "chain" TEXT NOT NULL DEFAULT 'stacks:mainnet',
ADD COLUMN     "chainFamily" TEXT NOT NULL DEFAULT 'stacks',
ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ContactMessage" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candle" (
    "id" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoolStatsHistory" (
    "id" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liquidityUsd" DOUBLE PRECISION NOT NULL,
    "tvlUsd" DOUBLE PRECISION NOT NULL,
    "volume24hUsd" DOUBLE PRECISION NOT NULL,
    "holderConcentration" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netWhaleFlowUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "PoolStatsHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- CreateIndex
CREATE INDEX "Candle_token_timeframe_timestamp_idx" ON "Candle"("token", "timeframe", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "Candle_token_timeframe_timestamp_key" ON "Candle"("token", "timeframe", "timestamp");

-- CreateIndex
CREATE INDEX "PoolStatsHistory_token_timestamp_idx" ON "PoolStatsHistory"("token", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_chainFamily_address_key" ON "Wallet"("chainFamily", "address");

