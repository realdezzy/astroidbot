-- Per-pool ingestion cursor for Solana.
--
-- Every other family walks a block range, so one cursor per chain suffices.
-- Solana's getSignaturesForAddress is per account and pages backwards from the
-- newest signature, bounded by an `until` — there is no slot-range query for an
-- account. Pools are discovered at different times and therefore catch up at
-- different times, which a chain-wide cursor cannot represent.
ALTER TABLE "IndexedPool" ADD COLUMN IF NOT EXISTS "lastSignature" TEXT;
