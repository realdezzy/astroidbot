-- Downward history walks for the two families that had none.
--
-- Backfill shipped for EVM only, because EVM is the family where "walk
-- backwards" means "ask for an earlier block range". Stacks pages an address's
-- transaction list by offset and Solana pages an account's signatures by
-- `before` — neither can be addressed by height, so neither could reuse the
-- block-range cursor and both spent their first day reporting a 24H figure
-- computed from however much of the day had elapsed since the container
-- started.

-- Solana walks per pool, mirroring lastSignature: pools are discovered at
-- different times and so reach the window at different times, which a
-- chain-wide mark cannot express.
ALTER TABLE "IndexedPool" ADD COLUMN IF NOT EXISTS "backfillSignature" TEXT;
ALTER TABLE "IndexedPool" ADD COLUMN IF NOT EXISTS "backfillDone" BOOLEAN NOT NULL DEFAULT false;

-- Stacks walks per swap contract, and the resume point is an offset into an
-- address's transaction list rather than a height. Json because the shape is
-- that chain's business and nothing joins or filters on it.
ALTER TABLE "IndexerCursor" ADD COLUMN IF NOT EXISTS "backfillState" JSONB;

-- Pools that already exist are left with a null backfillSignature, which reads
-- as "not seeded yet" and is picked up by the next forward pass. It is
-- deliberately *not* seeded from lastSignature here: that is the newest swap
-- seen, so walking down from it would re-read everything already ingested.
--
-- Unlike the EVM migration, which had to mark existing chains done for exactly
-- that reason, re-reading is now merely wasteful rather than corrupting —
-- IndexedSwap is keyed by the swap's on-chain identity, so a replay inserts
-- nothing and candles are recomputed rather than added to. The seeding is
-- still done from the forward pass because wasted RPC calls are worth avoiding
-- on their own.
