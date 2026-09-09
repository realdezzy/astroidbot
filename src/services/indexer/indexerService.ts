import { ChainAdapterRegistry } from "../chains/chainAdapterRegistry.js";
import { ChainHealthMonitor } from "../chains/chainHealth.js";
import { hasRpcOverride, rpcEnvKey } from "../chains/evm/evmClient.js";
import { ConfigManager } from "../../config.js";
import { RedisService } from "../redis.js";
import { logger } from "../../utils/logger.js";
import { UniswapV3Indexer } from "./evm/uniswapV3Indexer.js";
import { StacksIndexer } from "./stacks/stacksIndexer.js";
import { SolanaIndexer } from "./svm/solanaIndexer.js";
import { indexerSettings, settingsForChain, type IndexerSettings } from "./settings.js";
import type { ChainIndexer, IndexRunResult } from "./types.js";
import type { ChainDescriptor } from "../../types/chain.js";

/**
 * The indexer implementations, tried in order.
 *
 * One per *ingestion shape*, not per chain: every Uniswap-V3 fork emits
 * byte-identical logs, so one implementation serves Ethereum, Base, Celo and
 * Robinhood. Stacks and Solana are here because their shapes genuinely differ
 * — a transaction-shaped API with Clarity prints, and per-account signature
 * paging with balance deltas — not because they are different networks.
 *
 * A descriptor matching none of them is un-indexable, which is a normal state.
 */
const INDEXERS: {
  canIndex(descriptor: ChainDescriptor): boolean;
  create(descriptor: ChainDescriptor, settings: IndexerSettings): ChainIndexer;
}[] = [
  {
    canIndex: (d) => UniswapV3Indexer.canIndex(d),
    create: (d, s) => new UniswapV3Indexer(d, s),
  },
  {
    canIndex: (d) => StacksIndexer.canIndex(d),
    create: (d, s) => new StacksIndexer(d, s),
  },
  {
    canIndex: (d) => SolanaIndexer.canIndex(d),
    create: (d, s) => new SolanaIndexer(d, s),
  },
];

/** Redis key for a chain's ingestion lock. */
const lockKey = (chainId: string): string => `indexer:ingest:${chainId}`;

/**
 * Consecutive ticks with no cursor movement before a chain is called stalled.
 *
 * Generous on purpose. A chain that is genuinely caught up reports the same
 * `toBlock` only until the next block is mined, so on any live chain this
 * counter resets within a tick or two; reaching five means every range read
 * was refused, which is a real fault rather than a quiet minute.
 */
const STALL_TICKS = 5;

/** What we know about one chain's forward progress. */
interface ChainProgress {
  lastToBlock: bigint;
  stalledSince: Date | null;
  ticks: number;
}

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
  private progress = new Map<string, ChainProgress>();
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
      const build = INDEXERS.find((candidate) => candidate.canIndex(descriptor));

      if (!build) {
        logger.debug("[indexer] chain not indexable, skipping", {
          chainId: descriptor.chainId,
        });
        continue;
      }

      try {
        // Settings are resolved per chain, not shared: the block-denominated
        // safety margins mean different spans of time on a 100ms chain than on
        // a 12s one, and one number for both protects neither well.
        const chainSettings = settingsForChain(descriptor, settings);

        if (chainSettings.confirmations !== settings.confirmations) {
          logger.info("[indexer] chain-specific safety margins", {
            chainId: descriptor.chainId,
            blockTimeSeconds: descriptor.indexer?.blockTimeSeconds,
            confirmations: chainSettings.confirmations,
            reorgWindowSeconds: descriptor.indexer?.blockTimeSeconds
              ? Math.round(chainSettings.confirmations * descriptor.indexer.blockTimeSeconds)
              : undefined,
            initialLookbackBlocks: chainSettings.initialLookbackBlocks,
          });
        }

        // An indexed chain on a public default endpoint will be throttled, and
        // by the time that shows up it looks like a chain with no swaps rather
        // than like a client being refused. This is the one place that knows a
        // chain is *actually* being indexed — `registerChains` would have to
        // duplicate the `canIndex` predicates to say the same thing, and a
        // duplicated predicate drifts.
        if (!hasRpcOverride(descriptor.chainId)) {
          logger.warn("[indexer] chain is indexed but has no RPC override", {
            chainId: descriptor.chainId,
            envVar: rpcEnvKey(descriptor.chainId),
            hint:
              "Ingestion is the heaviest RPC consumer here and public endpoints " +
              "rate-limit hard. Point this chain at a paid endpoint.",
          });
        }

        this.indexers.set(descriptor.chainId, build.create(descriptor, chainSettings));
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

    // An unreachable Redis is rethrown rather than read as "locked". Both used
    // to arrive here as null, and null means skip — so a Redis outage stopped
    // ingestion on every chain, every tick, indefinitely, while emitting
    // nothing above debug and leaving /health reporting ok. The throw
    // propagates to runPass(), which counts it as a failure and degrades the
    // health endpoint after three in a row.
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

      this.noteProgress(chainId, result);
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

  /**
   * Records whether a chain's cursor actually moved.
   *
   * A run that returns without error but leaves the cursor where it was is the
   * failure mode this codebase keeps rediscovering: an unreadable range is
   * *supposed* to hold the cursor so the next tick retries it, which is exactly
   * right for a blip and exactly wrong for a provider limit that will never
   * lift. The two are indistinguishable from one tick, so the distinction has
   * to be made over many — and then said out loud.
   */
  private noteProgress(chainId: string, result: IndexRunResult): void {
    const previous = this.progress.get(chainId);
    const advanced = previous == null || result.toBlock > previous.lastToBlock;

    if (advanced) {
      this.progress.set(chainId, { lastToBlock: result.toBlock, stalledSince: null, ticks: 0 });
      return;
    }

    const stalledSince = previous.stalledSince ?? new Date();
    const ticks = previous.ticks + 1;
    this.progress.set(chainId, { lastToBlock: previous.lastToBlock, stalledSince, ticks });

    // Once, on crossing the threshold. Repeating it every tick would bury the
    // rest of the log in the outage it is reporting.
    if (ticks === STALL_TICKS) {
      logger.error("[indexer] cursor has not advanced — ingestion is stalled", {
        chainId,
        atBlock: previous.lastToBlock.toString(),
        ticks,
        since: stalledSince.toISOString(),
        hint:
          "Every range this chain read was refused. Most often an RPC provider " +
          "limit the log reader does not recognise; check the preceding " +
          "[indexer] getLogs failed warnings for the endpoint's own wording.",
      });
    }
  }

  /**
   * Per-chain ingestion progress, for the health endpoint.
   *
   * `stalled` is the answer to "why is discovery empty" that neither the run
   * count nor the error count can give: a stalled chain has no errors and a
   * rising run count.
   */
  progressSnapshot(): Record<string, { lastBlock: string; stalled: boolean; stalledSince: string | null }> {
    const out: Record<string, { lastBlock: string; stalled: boolean; stalledSince: string | null }> = {};

    for (const [chainId, state] of this.progress) {
      out[chainId] = {
        lastBlock: state.lastToBlock.toString(),
        stalled: state.ticks >= STALL_TICKS,
        stalledSince: state.stalledSince?.toISOString() ?? null,
      };
    }

    return out;
  }

  /** Test seam — lets a suite install a stub indexer for a chain. */
  register(indexer: ChainIndexer): void {
    this.initialised = true;
    this.indexers.set(indexer.chainId, indexer);
  }

  reset(): void {
    this.indexers.clear();
    this.running.clear();
    this.progress.clear();
    this.initialised = false;
  }
}
