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
  /** Addresses per log filter; providers reject very large arrays. */
  maxAddressesPerFilter: number;
  /**
   * How many times a failing log range may be halved before giving up.
   * 12 splits a 20k-block range down to single blocks.
   */
  maxSplitDepth: number;
  /** Pause before the single retry given to a transient RPC failure. */
  retryBackoffMs: number;
}

export function indexerSettings(): IndexerSettings {
  const config = ConfigManager.getInstance().config;
  return {
    confirmations: config.INDEXER_CONFIRMATIONS,
    blockChunkSize: config.INDEXER_BLOCK_CHUNK_SIZE,
    maxBlocksPerRun: config.INDEXER_MAX_BLOCKS_PER_RUN,
    initialLookbackBlocks: config.INDEXER_INITIAL_LOOKBACK_BLOCKS,
    maxPools: config.INDEXER_MAX_POOLS_PER_CHAIN,
    maxAddressesPerFilter: config.INDEXER_MAX_ADDRESSES_PER_FILTER,
    maxSplitDepth: config.INDEXER_MAX_SPLIT_DEPTH,
    retryBackoffMs: config.INDEXER_RETRY_BACKOFF_MS,
  };
}
