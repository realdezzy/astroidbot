import { ChainAdapterRegistry } from "../chains/chainAdapterRegistry.js";
import { ChainHealthMonitor } from "../chains/chainHealth.js";
import { ConfigManager } from "../../config.js";
import { RedisService } from "../redis.js";
import { logger } from "../../utils/logger.js";
import { UniswapV3Indexer } from "./evm/uniswapV3Indexer.js";
import { indexerSettings } from "./settings.js";
import type { ChainIndexer, IndexRunResult } from "./types.js";

/** Redis key for a chain's ingestion lock. */
const lockKey = (chainId: string): string => `indexer:ingest:${chainId}`;

/**
 * Drives per-chain ingestion.
 *
 * A run is skipped rather than queued if another is already in flight for that
 * chain. The tick interval and the time to ingest a range are unrelated
 * numbers, and overlapping runs would both read the same cursor, both ingest
 * the same blocks, and both add the resulting volume — which accumulates
 * additively, so the inflation is permanent and invisible.
 *
 * That exclusion is enforced twice, deliberately. The in-process `running` set
 * catches the common case without touching Redis. The Redis lock catches the
 * case the in-process set cannot even see: ingestion runs in its own
 * container, so "another run" may be another *process* — a second replica, or
 * a deploy overlapping its predecessor.
 *
 * The lock is per chain rather than per pass. Chains are bound by different
 * RPC endpoints, so one locked chain must not hold up the rest.
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

  /**
   * Chain ids this process ingests, building the indexer set if it hasn't been
   * built yet. Reported by the health endpoint, where an empty list is the
   * answer to "why is discovery empty" — every enabled chain lacks a factory
   * address.
   */
  indexedChains(): string[] {
    this.init();
    return [...this.indexers.keys()];
  }

  /**
   * One ingestion pass across every indexed chain.
   *
   * Chains run concurrently — they share no state and are bound by different
   * RPC endpoints, so serialising them would make the slowest chain set the
   * pace for all of them. Failures are isolated per chain.
   */
  async runAll(): Promise<IndexRunResult[]> {
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

    const redis = RedisService.getInstance();
    const ttl = ConfigManager.getInstance().config.INDEXER_LOCK_TTL_MS;
    const token = await redis.acquireLock(lockKey(chainId), ttl);

    // Held by another process. Skipping is correct and not an error: whoever
    // holds it is ingesting this chain right now, and the next tick will find
    // the cursor already advanced.
    if (!token) {
      logger.debug("[indexer] chain locked by another process, skipping", { chainId });
      return null;
    }

    this.running.add(chainId);
    const startedAt = Date.now();

    try {
      // Tracked for per-chain health: the indexer touches every indexed chain
      // every tick, which makes it by far the best signal for "can this
      // process reach that chain at all".
      const result = await ChainHealthMonitor.getInstance().track(chainId, () => indexer.run());

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
      await redis.releaseLock(lockKey(chainId), token);
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
