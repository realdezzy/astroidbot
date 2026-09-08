import { ConfigManager } from "../../config.js";
import type { ChainDescriptor } from "../../types/chain.js";

/**
 * Tunables for one indexer run.
 *
 * These are the knobs that decide whether the indexer is a background hum or
 * the thing that melts your RPC quota, so they're explicit rather than
 * scattered as literals through the ingestion code.
 */
export interface IndexerSettings {
  /**
   * Blocks to stay behind the head, so the cursor never enters a reorg.
   * A floor — `settingsForChain` raises it to cover `confirmationSeconds` on
   * chains that state their block time.
   */
  confirmations: number;
  /**
   * Wall-clock reorg depth to aim for, in seconds.
   *
   * The number that actually matters: "twelve blocks" means nothing without a
   * block time, and this deployment's chains range from ~100ms to ~12s.
   */
  confirmationSeconds: number;
  /** Blocks per `eth_getLogs` call. Providers cap this; 2k is widely safe. */
  blockChunkSize: number;
  /** Ceiling on blocks processed per tick, so catch-up can't stall a cycle. */
  maxBlocksPerRun: number;
  /**
   * How far back a never-indexed chain starts. Not a full backfill.
   * A floor, raised to cover `initialLookbackHours` where block time is known.
   */
  initialLookbackBlocks: number;
  /** Hours of recent history a first run should reach, where derivable. */
  initialLookbackHours: number;
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

/**
 * The global settings, adjusted for one chain's block rate.
 *
 * `confirmations` and `initialLookbackBlocks` are counted in blocks but exist
 * to protect a span of *time* — a reorg window, and enough recent history to
 * bootstrap from. Block times across the enabled set span two orders of
 * magnitude, so a single block count delivers wildly different guarantees:
 * twelve blocks is 144 seconds on Ethereum and 1.2 seconds on Robinhood, which
 * is thin enough to be notional.
 *
 * So the block counts are treated as **floors** and raised to whatever the
 * chain's block rate says the time target needs. Raised, never lowered: the
 * configured value is someone's explicit decision and a derivation should not
 * quietly weaken it. A chain that states no block time keeps the globals
 * exactly, so this is inert until a descriptor opts in.
 */
export function settingsForChain(
  descriptor: ChainDescriptor,
  base: IndexerSettings
): IndexerSettings {
  const chain = descriptor.indexer;
  if (!chain) return base;

  const blockTime = chain.blockTimeSeconds;
  const derived = (targetSeconds: number, floor: number): number =>
    blockTime && blockTime > 0
      ? Math.max(floor, Math.ceil(targetSeconds / blockTime))
      : floor;

  return {
    ...base,
    confirmations:
      chain.confirmations ?? derived(base.confirmationSeconds, base.confirmations),
    initialLookbackBlocks:
      chain.initialLookbackBlocks ??
      derived(base.initialLookbackHours * 3600, base.initialLookbackBlocks),
  };
}

export function indexerSettings(): IndexerSettings {
  const config = ConfigManager.getInstance().config;
  return {
    confirmations: config.INDEXER_CONFIRMATIONS,
    confirmationSeconds: config.INDEXER_CONFIRMATION_SECONDS,
    blockChunkSize: config.INDEXER_BLOCK_CHUNK_SIZE,
    maxBlocksPerRun: config.INDEXER_MAX_BLOCKS_PER_RUN,
    initialLookbackBlocks: config.INDEXER_INITIAL_LOOKBACK_BLOCKS,
    initialLookbackHours: config.INDEXER_INITIAL_LOOKBACK_HOURS,
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
