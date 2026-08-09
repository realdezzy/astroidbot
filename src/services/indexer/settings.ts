import { ConfigManager } from "../../config.js";

/**
 * Tunables for one indexer run.
 *
 * These are the knobs that decide whether the indexer is a background hum or
 * the thing that melts your RPC quota, so they're explicit rather than
 * scattered as literals through the ingestion code.
 */
export interface IndexerSettings {
  /** Blocks to stay behind the head, so the cursor never enters a reorg. */
  confirmations: number;
  /** Blocks per `eth_getLogs` call. Providers cap this; 2k is widely safe. */
  blockChunkSize: number;
  /** Ceiling on blocks processed per tick, so catch-up can't stall a cycle. */
  maxBlocksPerRun: number;
  /** How far back a never-indexed chain starts. Not a full backfill. */
  initialLookbackBlocks: number;
  /** Pools tracked per chain, most-recently-active first. */
  maxPools: number;
  /** Swap-bearing transactions inspected per tick on transaction-shaped chains. */
  maxTxPerRun: number;
  /** Addresses per log filter; providers reject very large arrays. */
  maxAddressesPerFilter: number;
  /**
   * How many times a failing log range may be halved before giving up.
   * 12 splits a 20k-block range down to single blocks.
   */
  maxSplitDepth: number;
  /** Pause before the single retry given to a transient RPC failure. */
  retryBackoffMs: number;
  /** Hours of history the downward backfill walk aims to cover. 0 disables it. */
  backfillWindowHours: number;
  /** Ceiling on blocks the backfill may walk per tick. */
  maxBackfillBlocksPerRun: number;
  /** Pools or contracts backfilled per tick on transaction-shaped chains. */
  maxBackfillSourcesPerRun: number;
  /** Walk all of history instead of `backfillWindowHours` of it. */
  backfillFullHistory: boolean;
}

/**
 * Whether the downward walk should run at all.
 *
 * Full history overrides the window rather than adding to it, so
 * `INDEXER_BACKFILL_FULL_HISTORY=true` with a window of 0 means "everything"
 * rather than "nothing" — the explicit switch beats the tuning knob.
 */
export function backfillEnabled(settings: IndexerSettings): boolean {
  return settings.backfillFullHistory || settings.backfillWindowHours > 0;
}

/**
 * The oldest timestamp the walk aims to reach, or null for all of history.
 *
 * A moving target on purpose: the window is *rolling*, so as the clock advances
 * so does the point at which enough history exists. A walk that stops there
 * stays stopped.
 */
export function backfillCutoffMs(settings: IndexerSettings, now = Date.now()): number | null {
  if (settings.backfillFullHistory) return null;
  return now - settings.backfillWindowHours * 3_600_000;
}

export function indexerSettings(): IndexerSettings {
  const config = ConfigManager.getInstance().config;
  return {
    confirmations: config.INDEXER_CONFIRMATIONS,
    blockChunkSize: config.INDEXER_BLOCK_CHUNK_SIZE,
    maxBlocksPerRun: config.INDEXER_MAX_BLOCKS_PER_RUN,
    initialLookbackBlocks: config.INDEXER_INITIAL_LOOKBACK_BLOCKS,
    maxPools: config.INDEXER_MAX_POOLS_PER_CHAIN,
    maxTxPerRun: config.INDEXER_MAX_TX_PER_RUN,
    maxAddressesPerFilter: config.INDEXER_MAX_ADDRESSES_PER_FILTER,
    maxSplitDepth: config.INDEXER_MAX_SPLIT_DEPTH,
    retryBackoffMs: config.INDEXER_RETRY_BACKOFF_MS,
    backfillWindowHours: config.INDEXER_BACKFILL_WINDOW_HOURS,
    maxBackfillBlocksPerRun: config.INDEXER_MAX_BACKFILL_BLOCKS_PER_RUN,
    maxBackfillSourcesPerRun: config.INDEXER_MAX_BACKFILL_SOURCES_PER_RUN,
    backfillFullHistory: config.INDEXER_BACKFILL_FULL_HISTORY,
  };
}
