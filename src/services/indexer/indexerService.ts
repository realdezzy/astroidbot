import { ChainAdapterRegistry } from "../chains/chainAdapterRegistry.js";
import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { UniswapV3Indexer } from "./evm/uniswapV3Indexer.js";
import { indexerSettings } from "./settings.js";
import type { ChainIndexer, IndexRunResult } from "./types.js";

/**
 * Drives per-chain ingestion.
 *
 * Runs off the existing `runCycle()` tick rather than a scheduler of its own —
 * the codebase has exactly one timer by design, and a second one is how you
 * end up with two components disagreeing about how often "every minute" is.
 *
 * A run is skipped rather than queued if the previous one is still going. The
 * cycle interval and the time to ingest a range are unrelated numbers, and
 * overlapping runs on the same chain would contend on the cursor row.
 */
export class IndexerService {
  private static instance: IndexerService;

  private indexers = new Map<string, ChainIndexer>();
  private running = new Set<string>();
  private initialised = false;

  static getInstance(): IndexerService {
    if (!IndexerService.instance) IndexerService.instance = new IndexerService();
    return IndexerService.instance;
  }

  /**
   * Builds an indexer for every enabled chain that can support one.
   *
   * A chain without a factory address is skipped quietly: being un-indexable
   * is a normal state (Arc has no DEX at all yet), not a misconfiguration.
   */
  private init(): void {
    if (this.initialised) return;
    this.initialised = true;

    const settings = indexerSettings();

    for (const descriptor of ChainAdapterRegistry.getInstance().list()) {
      if (!UniswapV3Indexer.canIndex(descriptor)) {
        logger.debug("[indexer] chain not indexable, skipping", {
          chainId: descriptor.chainId,
        });
        continue;
      }

      try {
        this.indexers.set(descriptor.chainId, new UniswapV3Indexer(descriptor, settings));
      } catch (error) {
        logger.warn("[indexer] failed to build indexer", {
          chainId: descriptor.chainId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info("[indexer] initialised", { chains: [...this.indexers.keys()] });
  }

  /** True when this deployment indexes at all. */
  enabled(): boolean {
    return ConfigManager.getInstance().config.INDEXER_ENABLED;
  }

  /**
   * One ingestion pass across every indexed chain.
   *
   * Chains run concurrently — they share no state and are bound by different
   * RPC endpoints, so serialising them would make the slowest chain set the
   * pace for all of them. Failures are isolated per chain.
   */
  async runAll(): Promise<IndexRunResult[]> {
    if (!this.enabled()) return [];
    this.init();

    const results = await Promise.all(
      [...this.indexers.entries()].map(([chainId, indexer]) => this.runOne(chainId, indexer))
    );

    return results.filter((r): r is IndexRunResult => r !== null);
  }

  private async runOne(chainId: string, indexer: ChainIndexer): Promise<IndexRunResult | null> {
    if (this.running.has(chainId)) {
      logger.debug("[indexer] previous run still in flight, skipping", { chainId });
      return null;
    }

    this.running.add(chainId);
    const startedAt = Date.now();

    try {
      const result = await indexer.run();

      if (result.swapsIngested > 0 || result.poolsDiscovered > 0) {
        logger.info("[indexer] ingested", {
          chainId,
          pools: result.poolsDiscovered,
          swaps: result.swapsIngested,
          buckets: result.bucketsWritten,
          blocks: `${result.fromBlock}-${result.toBlock}`,
          ms: Date.now() - startedAt,
        });
      }

      return result;
    } catch (error) {
      logger.warn("[indexer] run failed", {
        chainId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      this.running.delete(chainId);
    }
  }

  /** Test seam — lets a suite install a stub indexer for a chain. */
  register(indexer: ChainIndexer): void {
    this.initialised = true;
    this.indexers.set(indexer.chainId, indexer);
  }

  reset(): void {
    this.indexers.clear();
    this.running.clear();
    this.initialised = false;
  }
}
