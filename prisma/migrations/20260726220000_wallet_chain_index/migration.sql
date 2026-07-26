-- Chain identity: `chain` becomes the dispatch key.
--
-- `Wallet.chain` has been populated with adapter.chainId() since the column was
-- added, but dispatch keyed off `chainFamily`, which cannot distinguish Base
-- from Celo. This backfills any row where the two disagree and indexes the
-- column now that it is read on every trade.

-- 1. Backfill rows whose `chain` is empty or inconsistent with `chainFamily`.
--    Only touches rows that are actually wrong; a correct row is left alone.
UPDATE "Wallet"
SET "chain" = 'stacks:mainnet'
WHERE "chainFamily" = 'stacks'
  AND ("chain" IS NULL OR "chain" = '' OR "chain" NOT LIKE 'stacks:%');

UPDATE "Wallet"
SET "chain" = 'base:mainnet'
WHERE "chainFamily" = 'evm'
  AND ("chain" IS NULL OR "chain" = '' OR "chain" NOT LIKE '%:%');

-- 2. Wallet lookups are now per-user-per-chain (balances, pickers, quotes).
CREATE INDEX IF NOT EXISTS "Wallet_userId_chain_idx" ON "Wallet"("userId", "chain");
