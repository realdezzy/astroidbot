-- Downward backfill for newly-indexed chains.
--
-- A chain starts INDEXER_INITIAL_LOOKBACK_BLOCKS behind the head and never
-- filled in anything earlier, so for its first day every 24H figure was a
-- fraction of the real one with nothing on the page to say so — a token
-- trading steadily read as one drying up.
--
-- Separate marks from lastBlock because the walk moves the other way. Sharing
-- one cursor would make an unfinished backfill indistinguishable from having
-- fallen behind the head, and the responses to those are opposite.

ALTER TABLE "IndexerCursor" ADD COLUMN IF NOT EXISTS "backfillBlock" BIGINT;
ALTER TABLE "IndexerCursor" ADD COLUMN IF NOT EXISTS "backfillFloor" BIGINT;
ALTER TABLE "IndexerCursor" ADD COLUMN IF NOT EXISTS "backfillDone"  BOOLEAN NOT NULL DEFAULT false;

-- Chains already being indexed are marked done rather than given a walk.
--
-- Not a shortcut — the alternative is unsafe. There is no record of which
-- block a chain's ingestion originally started from, so any walk would have to
-- begin at the current lastBlock and descend through blocks already ingested.
-- Candle volume accumulates additively, so re-reading a committed range
-- inflates it permanently: the numbers would be wrong in a way that looks like
-- real trading and can never be distinguished from it afterwards.
--
-- The gap this feature closes only exists for a chain's first day, and a chain
-- already in this table is either past that or will be within a day.
UPDATE "IndexerCursor" SET "backfillDone" = true;
