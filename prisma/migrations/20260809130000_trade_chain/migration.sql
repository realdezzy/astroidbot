-- Record which chain a trade executed on.
--
-- A txId is only meaningful alongside its network, and every surface that
-- renders an explorer link needs both. Without this column the web app had
-- nothing to build a link from and hardcoded the Stacks explorer for every
-- trade — so a Base swap linked to a Hiro 404.
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "chain" TEXT;

-- Backfill from the wallet that executed it. Wallet.chain is authoritative for
-- dispatch and has been set on every wallet since the multichain migration, so
-- this is the same answer the trade would have recorded at the time — except
-- for a wallet whose chain was somehow never set, which stays null and falls
-- back to the wallet's current chain at read time.
UPDATE "Trade" t
SET "chain" = w."chain"
FROM "Wallet" w
WHERE t."walletId" = w."id"
  AND t."chain" IS NULL
  AND w."chain" IS NOT NULL;

-- Trades are listed newest-first per user and, on the discovery surfaces, per
-- chain. The existing index covers the first; this covers the second without
-- duplicating it.
CREATE INDEX IF NOT EXISTS "Trade_chain_createdAt_idx" ON "Trade"("chain", "createdAt");
