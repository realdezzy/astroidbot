-- Per-chain ERC-4337 gas sponsorship toggle.
--
-- TradeSettings is already keyed by (userId, context, chain), so the per-chain
-- part needs no new table — the choice belongs on the row that already scopes
-- everything else to a chain.
--
-- Defaults to true: every 4337 chain sponsored unconditionally before this
-- existed, and a migration that silently switched users to paying their own
-- gas would strand wallets holding no native asset.
ALTER TABLE "TradeSettings"
  ADD COLUMN IF NOT EXISTS "sponsorGas" BOOLEAN NOT NULL DEFAULT true;
