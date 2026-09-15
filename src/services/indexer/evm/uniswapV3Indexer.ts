import { V4_INITIALIZE, V4_SWAP } from "../protocols/uniswapV4Adapter.js";
import { refreshV4Liquidity } from "./v4Liquidity.js";
import { assertIngestionLease } from "../ingestionLease.js";
import { reconcileEvmHistory, evmCheckpoint, prepareEvmRange } from "./reorgGuard.js";
import { DexAdapterRegistry } from "../protocols/dexAdapterRegistry.js";
import { parseAbiItem, type Address, type PublicClient } from "viem";
import { DatabaseService } from "../../db.js";
import { batchingPublicClientFor } from "../../chains/evm/evmClient.js";
import { hasMulticall3, multicallRead, type MulticallRequest } from "../../chains/evm/multicall.js";
import { ERC20_ABI } from "../../chains/evm/abis.js";
import { logger } from "../../../utils/logger.js";
import { requireEvmConfig, type ChainDescriptor } from "../../../types/chain.js";
import { priceFromSqrtX96, toHuman } from "../priceMath.js";
import { persistSwaps, type RawSwap } from "../swapStore.js";
import { BlockTimeOracle } from "../blockTimeOracle.js";
import { resolveNativeUsd } from "../nativePricing.js";
import { bucketStartOf, type ChainIndexer, type IndexRunResult, type TrackedPool } from "../types.js";
import { backfillEnabled, type IndexerSettings } from "../settings.js";

/**
 * The two events that define V3 ingestion. Declared as ABI items rather than
 * raw topic hashes so viem decodes the arguments — hand-decoding an int256
 * from calldata is exactly the kind of thing that silently sign-flips.
 *
 * topic0 for these is 0x783cca1c… and 0xc42079f9… respectively; both were
 * confirmed against live logs before this shipped.
 */
const POOL_CREATED_EVENT = parseAbiItem(
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
);

const SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
);

const PAIR_CREATED_EVENT = parseAbiItem("event PairCreated(address indexed token0, address indexed token1, address pair, uint256)");
const V2_SWAP_EVENT = parseAbiItem("event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)");

const AERO_CREATED_EVENT = parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)");
const CL_CREATED_EVENT = parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, int24 indexed tickSpacing, address pool)");
const AERO_SWAP_EVENT = parseAbiItem("event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)");

/** A decoded `Swap` log, as viem hands it back from `getLogs`. */
type SwapLog = Awaited<ReturnType<PublicClient["getLogs"]>>[number] & {
  args: {
    sender?: Address;
    recipient?: Address;
    amount0?: bigint;
    amount1?: bigint;
    sqrtPriceX96?: bigint;
  };
};

/**
 * "You asked for too much" — the one error class subdivision actually fixes.
 *
 * Wordings differ per provider, so this matches the shapes seen in the wild.
 * Two distinct causes land here and both are fixed by asking for less: a
 * result set over the provider's cap, and a *block range* over it.
 *
 * The range variants are not decoration. Alchemy's free tier caps `eth_getLogs`
 * at ten blocks and says so in prose — "you can make eth_getLogs requests with
 * up to a 10 block range" — which matched nothing here. Unmatched means the
 * reader treats it as unknown, holds the cursor so the range is retried, and
 * retries it forever against a limit that will never lift: ingestion stops dead
 * with nothing above `warn` in the log and a green health endpoint. Any
 * provider limit this list doesn't know produces that same silence, which is
 * why `getLogsAdaptive` now also reports a range it has given up on.
 */
function isResultSetTooLarge(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("exceeds limit") ||
    m.includes("too many results") ||
    m.includes("more than") ||
    m.includes("query returned more than") ||
    m.includes("response size") ||
    m.includes("log response size") ||
    m.includes("block range is too large") ||
    m.includes("range too large") ||
    m.includes("block range") ||
    m.includes("blocks range") ||
    m.includes("block span") ||
    m.includes("range is too wide") ||
    m.includes("limited to") ||
    m.includes("query timeout exceeded") ||
    m.includes("-32005")
  );
}

/** Overload, rate limiting or a flaky connection: back off, don't subdivide. */
function isTransient(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("took too long") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("rate limit") ||
    m.includes("too many requests") ||
    m.includes("429") ||
    m.includes("503") ||
    m.includes("econnreset") ||
    m.includes("socket hang up") ||
    m.includes("fetch failed")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The block-range cap an endpoint states in its own refusal, if it states one.
 *
 * Two shapes are worth reading, because between them they cover the providers
 * that cap by range rather than by result count:
 *
 *   "up to a 10 block range"                        → 10
 *   "this block range should work: [0x1a, 0x23]"    → 10
 *
 * Anything else returns null and the caller falls back to halving. A parsed
 * number is only ever used to make the window *smaller*, so misreading one
 * costs throughput rather than correctness.
 */
export function parseBlockRangeLimit(message: string): bigint | null {
  const stated = /up to (?:a )?([\d,_]+)\s*block/i.exec(message);
  if (stated) {
    const value = BigInt(stated[1]!.replace(/[,_]/g, ""));
    if (value > 0n) return value;
  }

  const suggested = /\[\s*(0x[0-9a-f]+)\s*,\s*(0x[0-9a-f]+)\s*\]/i.exec(message);
  if (suggested) {
    const span = BigInt(suggested[2]!) - BigInt(suggested[1]!) + 1n;
    if (span > 0n) return span;
  }

  return null;
}

/**
 * Ingests Uniswap-V3-family swaps for one EVM chain.
 *
 * Every V3 deployment emits byte-identical `PoolCreated` and `Swap` logs, so
 * this one class serves Ethereum, Base, Celo and Robinhood — the descriptor
 * supplies the factory address and nothing else differs. That is the same
 * reuse argument that lets UniswapV3Provider cover all four for trading.
 *
 * Three properties the implementation is built around:
 *
 *  - **Bounded work.** Only pools paired against the chain's wrapped native or
 *    a curated stable are tracked, capped at `maxPools`. Indexing every pool on
 *    Ethereum is neither affordable nor useful: a token with no route to a
 *    priceable asset has no USD price to report anyway.
 *  - **Exactly-once.** Candle writes and the cursor advance commit in one
 *    transaction. Volume accumulates additively, so a range applied twice would
 *    double-count — the transaction is what makes that unrepresentable.
 *  - **Reorg safety.** Ingestion stops `confirmations` blocks behind the head,
 *    so the cursor never advances past history that can still be rewritten.
 */
export class UniswapV3Indexer implements ChainIndexer {
  readonly chainId: string;

  private readonly evm: ReturnType<typeof requireEvmConfig>;
  private client: PublicClient | null = null;
  /** contractId (lowercase) -> decimals. Decimals never change; no TTL needed. */
  private decimalsCache = new Map<string, number>();
  /**
   * Largest `getLogs` block range this endpoint has been shown to accept.
   *
   * Null until one is refused. A property of the endpoint rather than of any
   * range, so it is learned once and reused for the life of the process.
   */
  private maxBlockRange: bigint | null = null;

  constructor(
    private readonly descriptor: ChainDescriptor,
    private readonly settings: IndexerSettings
  ) {
    this.chainId = descriptor.chainId;
    this.evm = requireEvmConfig(descriptor);

    if (!this.factories.length) {
      throw new Error(
        `Chain ${descriptor.chainId} has no DEX factory configured — it cannot be indexed`
      );
    }
  }

  /** Whether a descriptor can back an indexer at all. */
  static canIndex(descriptor: ChainDescriptor): boolean {
    return descriptor.family === "evm" && Boolean(descriptor.evm?.v4PoolManager || descriptor.evm?.dex?.factory || descriptor.evm?.dex?.v2Factory || descriptor.evm?.indexerFactories?.length);
  }

  private get rpc(): PublicClient {
    // Batching transport: the indexer issues many concurrent reads per range
    // and cares about throughput, not the per-call latency that trade
    // execution optimises for.
    if (!this.client) this.client = batchingPublicClientFor(this.descriptor);
    return this.client;
  }

  private get dexId(): string {
    return (this.evm.dex?.name ?? "uniswap-v3").toLowerCase();
  }

  private get factories() {
    const defaults = [
      ...(this.evm.dex?.factory ? [{ address: this.evm.dex.factory, dexId: "uniswap-v3", protocol: "uniswap-v3" as const, deploymentBlock: 0n }] : []),
      ...(this.evm.dex?.v2Factory ? [{ address: this.evm.dex.v2Factory, dexId: "uniswap-v2", protocol: "uniswap-v2" as const, deploymentBlock: 0n }] : []),
    ];
    return [...(this.evm.indexerFactories ?? defaults), ...(this.evm.v4PoolManager ? [{ address: this.evm.v4PoolManager, dexId: "uniswap-v4", protocol: "uniswap-v4" as const }] : [])];
  }

  async run(): Promise<IndexRunResult> {
    const db = DatabaseService.getInstance();
    await reconcileEvmHistory(this.chainId, this.rpc);
    await this.retryPoolMetadata();
    const head = await this.rpc.getBlockNumber();
    const safeHead = head > BigInt(this.settings.confirmations) ? head - BigInt(this.settings.confirmations) : 0n;
    const cursor = await db.prisma.indexerCursor.findUnique({ where: { chainId: this.chainId } });
    const defaultStart = safeHead > BigInt(this.settings.initialLookbackBlocks)
      ? safeHead - BigInt(this.settings.initialLookbackBlocks) : 1n;
    const fromBlock = cursor ? cursor.lastBlock + 1n : defaultStart;
    const seed = fromBlock - 1n;
    if (!cursor) await db.prisma.indexerCursor.create({ data: {
      chainId: this.chainId, lastBlock: seed, lastPoolBlock: null, backfillBlock: fromBlock,
    } });
    const firstFactoryBlock = this.factories.reduce((min, f) => (f.deploymentBlock ?? 0n) < min ? (f.deploymentBlock ?? 0n) : min, safeHead);
    const poolFrom = cursor?.lastPoolBlock != null ? cursor.lastPoolBlock + 1n : firstFactoryBlock;
    const budget = BigInt(this.settings.maxBlocksPerRun);
    const toBlock = fromBlock + budget - 1n < safeHead ? fromBlock + budget - 1n : safeHead;
    const discoveryTo = poolFrom + budget - 1n < toBlock ? poolFrom + budget - 1n : toBlock;
    const poolsDiscovered = poolFrom <= discoveryTo ? await this.discoverPools(poolFrom, discoveryTo) : 0;
    // Never claim swaps from a range whose complete pool set is not known yet.
    if (discoveryTo < toBlock) return { chainId: this.chainId, poolsDiscovered,
      swapsIngested: 0, bucketsWritten: 0, fromBlock, toBlock: seed, targetBlock: safeHead, discoveryBlock: discoveryTo };
    const result = fromBlock <= safeHead ? await this.ingestSwaps(fromBlock, toBlock) : { swapsIngested: 0, bucketsWritten: 0 };
    const committed = await db.prisma.indexerCursor.findUnique({ where: { chainId: this.chainId } });
    const actual = committed?.lastBlock ?? seed;

    const backfilled = actual >= safeHead ? await this.backfillStep(safeHead) : { swapsIngested: 0, bucketsWritten: 0 };
    return { chainId: this.chainId, poolsDiscovered, fromBlock, toBlock: actual, targetBlock: safeHead,
      swapsIngested: result.swapsIngested + backfilled.swapsIngested,
      bucketsWritten: result.bucketsWritten + backfilled.bucketsWritten };
  }

  // ─── Backfill ──────────────────────────────────────────────────────────────

  /**
   * Walks history downward so the 24H columns aren't computed from a partial
   * window.
   *
   * A newly-indexed chain starts `initialLookbackBlocks` behind the head and
   * never fills in anything earlier, so for the first day of its life every
   * 24H figure is a fraction of the real one — and there is nothing on the
   * page to say so. A token that traded steadily reads as one that is drying
   * up, which is exactly backwards.
   *
   * Runs only when the forward pass is at the head, and takes at most
   * `maxBackfillBlocksPerRun` per tick.
   */
  private async backfillStep(
    safeHead: bigint
  ): Promise<{ swapsIngested: number; bucketsWritten: number }> {
    const none = { swapsIngested: 0, bucketsWritten: 0 };
    if (!backfillEnabled(this.settings)) return none;

    const db = DatabaseService.getInstance();
    const cursor = await db.prisma.indexerCursor.findUnique({
      where: { chainId: this.chainId },
    });
    if (!cursor || cursor.backfillDone) return none;

    let floor = cursor.backfillFloor;
    if (floor == null) {
      floor = await this.computeBackfillFloor(safeHead);
      if (floor == null) return none;
      await this.saveCursor({ backfillFloor: floor });
    }

    // Where the walk resumes. Absent only on a cursor that predates this
    // feature, where the original ingestion start is unrecoverable — falling
    // back to lastBlock would walk down through already-ingested blocks and
    // double-count their volume, so those chains are finished rather than
    // guessed at. The migration marks them done for the same reason.
    const start = cursor.backfillBlock;
    if (start == null) {
      await this.saveCursor({ backfillDone: true });
      return none;
    }

    if (start <= floor) {
      await this.saveCursor({ backfillDone: true });
      logger.info("[indexer] backfill complete", { chainId: this.chainId, floor: floor.toString() });
      return none;
    }

    const toBlock = start - 1n;
    const budget = BigInt(this.settings.maxBackfillBlocksPerRun);
    const fromBlock = toBlock - budget > floor ? toBlock - budget : floor;

    // Pools created after this range still have their swaps read here — a pool
    // simply emits nothing before it existed, so filtering by creation block
    // would only add a query for no saved work.
    const result = await this.ingestSwaps(fromBlock, toBlock, "backfill");

    logger.info("[indexer] backfilled", {
      chainId: this.chainId,
      blocks: `${fromBlock}-${toBlock}`,
      remaining: (fromBlock > floor ? fromBlock - floor : 0n).toString(),
      swaps: result.swapsIngested,
    });

    return result;
  }

  /**
   * The block roughly `backfillWindowHours` before the head.
   *
   * Measured rather than assumed. A fixed block count means wildly different
   * spans per chain — 50k blocks is a week of Ethereum and about three hours
   * of a sub-second L2 — so a constant would leave exactly the fast chains,
   * the ones with the most activity to miss, with the least history.
   *
   * Two block reads, once per chain, cached on the cursor row.
   */
  private async computeBackfillFloor(safeHead: bigint): Promise<bigint | null> {
    // Full history has a floor that needs no measuring. It is genesis rather
    // than the factory's deployment block because the factory address is the
    // only thing this class knows and reading its creation block is another
    // round trip for a bound the per-tick budget already enforces — the walk
    // simply finds nothing below the factory and finishes.
    if (this.settings.backfillFullHistory) return 0n;

    try {
      const SAMPLE_SPAN = 1_000n;
      if (safeHead <= SAMPLE_SPAN) return 0n;

      const [head, earlier] = await Promise.all([
        this.rpc.getBlock({ blockNumber: safeHead }),
        this.rpc.getBlock({ blockNumber: safeHead - SAMPLE_SPAN }),
      ]);

      const elapsed = Number(head.timestamp - earlier.timestamp);
      if (!Number.isFinite(elapsed) || elapsed <= 0) return null;

      const secondsPerBlock = elapsed / Number(SAMPLE_SPAN);
      const wanted = (this.settings.backfillWindowHours * 3600) / secondsPerBlock;
      if (!Number.isFinite(wanted) || wanted <= 0) return null;

      const span = BigInt(Math.ceil(wanted));
      return safeHead > span ? safeHead - span : 0n;
    } catch (error) {
      // Not fatal: the next tick tries again, and until then the chain simply
      // has no backfill rather than no ingestion.
      logger.warn("[indexer] could not measure block time for backfill", {
        chainId: this.chainId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // ─── Pool discovery ────────────────────────────────────────────────────────

  /**
   * Reads `PoolCreated` from the factory and records the pools worth tracking.
   *
   * The filter is applied here rather than at ingestion time so the pool table
   * itself stays small: a chain like Ethereum has hundreds of thousands of V3
   * pools and almost none of them are priceable or interesting.
   */
  private async discoverPools(fromBlock: bigint, toBlock: bigint): Promise<number> {
    const db = DatabaseService.getInstance();
    const priceable = this.priceableAddresses();

    let discovered = 0;
    let poolScanFailed = false;

    for (const [start, end] of this.chunks(fromBlock, toBlock)) {
      const logs = [];
      for (const factory of this.factories) {
        if (end < (factory.deploymentBlock ?? 0n)) continue;
        const found = await this.getLogsAdaptive(
          (from, to) => this.rpc.getLogs({ address: factory.address,
            event: factory.protocol === "uniswap-v4" ? V4_INITIALIZE : factory.protocol === "uniswap-v2" ? PAIR_CREATED_EVENT : factory.protocol === "aerodrome-v2" ? AERO_CREATED_EVENT : factory.protocol === "aerodrome-slipstream" ? CL_CREATED_EVENT : POOL_CREATED_EVENT,
            fromBlock: from, toBlock: to }), start, end
        );
        if (found === null) throw new Error(`Factory discovery incomplete at ${start}`);
        const adapter = DexAdapterRegistry.getInstance().getAdapter(factory.protocol, this.chainId)!;
        for (const log of found) {
          const decoded = adapter.decodePoolCreated(log, this.chainId);
          if (!decoded) throw new Error(`Invalid pool creation at ${start}`);
          logs.push({ ...decoded, dexId: factory.dexId });
        }
      }

      // Filter first, then read decimals for the survivors in one batch. Read
      // per pool inside the loop, a chunk that created fifty pools cost a
      // hundred sequential round trips before the first row was written.
      const candidates = logs.flatMap((log) => {
        const { token0: t0, token1: t1, feeTier: fee, poolAddress } = log;
        if (!t0 || !t1 || !poolAddress) return [];

        const native = "0x0000000000000000000000000000000000000000";
        const token0 = (t0.toLowerCase() === native ? this.evm.wrappedNative ?? t0 : t0).toLowerCase();
        const token1 = (t1.toLowerCase() === native ? this.evm.wrappedNative ?? t1 : t1).toLowerCase();

        // Only pools with a priceable side are worth ingesting — the other
        // side is what gives every swap a USD value.
        // Keep unanchored pairs too; USD pricing can be resolved transitively.

        // The quote side is the one we can price; the base is what the pool is
        // actually about. Every downstream metric is attributed to the base.
        const quoteToken = priceable.has(token1) ? token1 : token0;

        return [
          {
            pool: poolAddress.toLowerCase(),
            token0,
            token1,
            quoteToken,
            baseToken: quoteToken === token0 ? token1 : token0,
            feeTier: fee === undefined ? null : Number(fee),
            createdBlock: log.createdBlock,
            dexId: log.dexId,
            protocolState: log.protocolState,
          },
        ];
      });

      if (candidates.length === 0) continue;

      const decimals = await this.decimalsFor(
        candidates.flatMap((c) => [c.token0, c.token1])
      );

      /** Base sides seen this chunk, catalogued together once the pools exist. */
      const newTokens: { address: string; decimals: number }[] = [];

      for (const candidate of candidates) {
        const { pool, token0, token1, quoteToken, baseToken, feeTier, createdBlock, dexId, protocolState } = candidate;
        const decimals0 = decimals.get(token0) ?? 0;
        const decimals1 = decimals.get(token1) ?? 0;
        const indexingError = !decimals.has(token0) || !decimals.has(token1) ? "Token decimals unavailable; awaiting metadata" : null;

        try {
          await db.prisma.indexedPool.upsert({
            where: { chainId_poolAddress: { chainId: this.chainId, poolAddress: pool } },
            create: {
              chainId: this.chainId,
              dexId,
              poolAddress: pool,
              token0,
              token1,
              decimals0,
              decimals1,
              indexingError,
              ...(protocolState ? { protocolState } : {}),
              baseToken,
              quoteToken,
              feeTier,
              createdBlock,
              pairCreatedAt: new Date(Number((await this.rpc.getBlock({ blockNumber: createdBlock })).timestamp) * 1000),
            },
            // A rediscovered pool keeps its original creation data; only the
            // token metadata could have been wrong (unreadable decimals).
            update: { decimals0, decimals1, baseToken, quoteToken, indexingError },
          });

          // Catalogue the traded side so discovery can list it.
          //
          // Without this the catalogue only ever contains the handful of tokens
          // hardcoded in the descriptor, because that is all
          // `getSwappableTokens` knows about — and the entire point of an
          // indexer is the long tail that wasn't hardcoded anywhere. The
          // priceable side (WETH, a stable) is skipped: it's already curated.
          if (!indexingError) newTokens.push({
            address: baseToken,
            decimals: baseToken === token0 ? decimals0 : decimals1,
          });

          discovered++;
        } catch (error) {
          poolScanFailed = true;
          logger.warn("[indexer] pool upsert failed", {
            chainId: this.chainId,
            pool,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // After the pools exist, so a token is never catalogued for a pool that
      // failed to write. One identity read per new token for the whole chunk.
      await this.catalogueTokens(newTokens);
    }

    // Only claim the scanned range if all of it was actually readable.
    if (poolScanFailed) throw new Error("Pool writes incomplete; retaining discovery and swap cursors");
    await this.saveCursor({ lastPoolBlock: toBlock });
    return discovered;
  }

  // ─── Swap ingestion ────────────────────────────────────────────────────────

  /**
   * Ingests a block range into candles.
   *
   * `direction` decides which cursor the write advances, and nothing else.
   * Forward moves `lastBlock` up; backfill moves `backfillBlock` down. They
   * are separate marks because they meet in the middle from opposite ends —
   * sharing one would make an unfinished backfill indistinguishable from
   * having fallen behind the head, and the recovery for those is opposite.
   */
  private async ingestSwaps(
    fromBlock: bigint,
    toBlock: bigint,
    direction: "forward" | "backfill" = "forward"
  ): Promise<{ swapsIngested: number; bucketsWritten: number }> {
    const db = DatabaseService.getInstance();
    const pools = await this.trackedPools();
    if (direction === "forward") await prepareEvmRange(this.chainId, fromBlock);

    if (pools.length === 0) {
      // Nothing to read. Claim the range anyway: re-walking it next tick would
      // find the same nothing, and on a chain with no tracked pools that loop
      // never terminates.
      await this.saveCursor(
        direction === "forward" ? { lastBlock: toBlock } : { backfillBlock: fromBlock }
      );
      return { swapsIngested: 0, bucketsWritten: 0 };
    }

    const rangeHash = (await this.rpc.getBlock({ blockNumber: toBlock })).hash;
    if (!rangeHash) throw new Error("Missing range boundary hash");

    const byAddress = new Map(pools.map((p) => [p.poolAddress.toLowerCase(), p]));
    const usd = await this.usdPrices(pools);
    const rawSwaps: RawSwap[] = [];
    const poolState = new Map<number, { price: number; at: Date }>();

    let swapsIngested = 0;
    /** First block of the earliest unreadable chunk; the cursor stops before it. */
    let failedAt: bigint | null = null;

    /**
     * Every swap log in the range, collected before any of them is decoded.
     *
     * The decode needs a block timestamp, and timestamps are what the oracle
     * has to buy from the chain. Collecting first means the oracle can be
     * primed from the blocks that actually emitted a swap rather than from the
     * range those blocks sit in — on a quiet tick that is the difference
     * between two block reads and one per block scanned.
     */
    const collected: SwapLog[] = [];

    const addressChunks = this.chunkArray(
      [...byAddress.keys()],
      this.settings.maxAddressesPerFilter
    );

    for (const [start, end] of this.chunks(fromBlock, toBlock)) {
      // Address-filtered rather than topic-only: on a chain like Ethereum a
      // bare topic filter returns every V3-shaped swap in the range, which is
      // orders of magnitude more data than the tracked set needs.
      //
      // The address chunks are fetched together and merged before processing,
      // so a range's block timestamps can be resolved in one batch below
      // rather than per chunk.
      const fetched = await Promise.all(
        addressChunks.map((addresses) =>
          this.getLogsAdaptive(
            (from, to) =>
              this.readSwapLogs(addresses, from, to),
            start,
            end
          )
        )
      );

      // A chunk that couldn't be fetched must not be stepped over: the cursor
      // stops short of it so the next tick retries the same blocks. Advancing
      // regardless would silently drop those swaps forever, and the resulting
      // gap is invisible — the numbers would just be quietly wrong.
      if (fetched.some((f) => f === null)) {
        failedAt = start;
        break;
      }

      for (const log of fetched.flat()) {
        if (log !== null) collected.push(log);
      }
    }

    // Only now, and only for the blocks that actually emitted something. A
    // range with four swaps in three blocks costs three timestamps, not one
    // per block in the range — and a range with no swaps costs none at all.
    const clock = new BlockTimeOracle(this.rpc, Number.MAX_SAFE_INTEGER, 25, true);
    await clock.primeBlocks(collected.map((log) => log.blockNumber));

    // Block order matters: `open` is the first price written to a bucket and
    // `close` the last, so out-of-order application inverts both. Sorted
    // across the whole range rather than per chunk, since a pool can trade in
    // more than one chunk and the buckets do not respect chunk boundaries.
    collected.sort((a, b) => {
      const blockDelta = Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n));
      return blockDelta !== 0 ? blockDelta : (a.logIndex ?? 0) - (b.logIndex ?? 0);
    });

    for (const log of collected) {
      const pool = byAddress.get(log.address.toLowerCase());
      if (!pool) continue;

      const protocol = this.factories.find((f) => f.dexId === pool.dexId)?.protocol ?? "uniswap-v3";
      const decoded = DexAdapterRegistry.getInstance().getAdapter(protocol, this.chainId)!.decodeSwap(pool, log);
      if (!decoded) throw new Error(`Invalid swap log for ${pool.poolAddress}`);
      const token0In = decoded.tokenIn.toLowerCase() === pool.token0;
      const amount0 = token0In ? decoded.amountIn : -decoded.amountOut;
      const amount1 = token0In ? -decoded.amountOut : decoded.amountIn;
      const traderAddress = decoded.traderAddress;
      const timestamp = log.blockNumber != null ? clock.timeOf(log.blockNumber) : Date.now();
      const price0In1 = decoded.price0In1;

      const { volumeUsd, isBuy, priceUsd } = this.valueSwap(pool, amount0, amount1, price0In1, usd);

      rawSwaps.push({
        poolId: pool.id,
        txKey: `${log.transactionHash}:${log.logIndex ?? 0}`,
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
        bucketStart: bucketStartOf(timestamp),
        priceUsd,
        volumeUsd,
        isBuy,
        traderAddress: traderAddress || undefined,
      });
      poolState.set(pool.id, { price: price0In1, at: new Date(timestamp) });
      swapsIngested++;
    }

    // Swaps are stored and the buckets they touch are recomputed from
    // storage. The cursor move below no longer has to share a transaction with
    // this for correctness — a replay is a no-op — but it still commits with
    // the pool-state writes, which are last-write-wins.
    // Capture the checkpoint before writing and verify the range did not change while reading.
    const committedTo = failedAt != null ? failedAt - 1n : toBlock;
    const forwardState = direction === "forward" ? await evmCheckpoint(this.chainId, committedTo, this.rpc) : undefined;
    if ((await this.rpc.getBlock({ blockNumber: toBlock })).hash !== rangeHash) throw new Error("Chain reorganized during log scan");
    const bucketsWritten = await persistSwaps(rawSwaps);

    // Commit only as far as we actually read. If a chunk was unreadable the
    // cursor stops at the block before it, so the gap is re-attempted rather
    // than skipped — and because the candle write and the cursor move commit
    // together, the blocks we do claim are exactly the blocks we ingested.
    if (failedAt != null) {
      logger.warn("[indexer] range partially ingested; cursor held back", {
        chainId: this.chainId,
        committedTo: committedTo.toString(),
        retryFrom: failedAt.toString(),
      });
    }

    // The write and the cursor advance are one transaction. Volume is
    // accumulated additively, so replaying a committed range would inflate it;
    // committing both together makes that state unreachable.
    //
    // Backfill claims from the *bottom* of the range: a partial read means the
    // walk resumes above the gap and tries it again, mirroring how the forward
    // pass holds its cursor below one.
    const cursorMove =
      direction === "forward"
        ? { lastBlock: committedTo }
        : { backfillBlock: failedAt != null ? toBlock + 1n : fromBlock };

    // `lastPrice0`/`lastSwapAt` mean *latest*, and a backfill is reading older
    // blocks than anything already recorded — writing them here would move a
    // pool's current price backwards in time, and since the deepest pool sets
    // a token's displayed price, that shows up as the quoted price randomly
    // jumping to a stale one.
    const poolStateWrites =
      direction === "forward"
        ? [...poolState.entries()].map(([poolId, state]) =>
            db.prisma.indexedPool.update({
              where: { id: poolId },
              data: { lastPrice0: state.price, lastSwapAt: state.at },
            })
          )
        : [];

    await assertIngestionLease();
    await db.prisma.$transaction([
      ...poolStateWrites,
      db.prisma.indexerCursor.upsert({
        where: { chainId: this.chainId },
        create: { chainId: this.chainId, lastBlock: committedTo, lastPoolBlock: committedTo },
        update: { ...cursorMove, ...(forwardState ? { forwardState } : {}) },
      }),
    ]);

    // Liquidity is refreshed only for pools that actually traded. It costs two
    // balance reads per pool, and a pool with no swaps this tick has neither
    // moved nor become more interesting. Skipped entirely on backfill: the
    // reads return *today's* balances, so attributing them to a pool because
    // of a trade last week is both wrong and paid for in RPC calls.
    if (direction === "forward") {
      await this.refreshLiquidity([...poolState.keys()], byAddress, usd, toBlock);
    }

    return { swapsIngested, bucketsWritten };
  }

  /**
   * Recomputes pool liquidity from on-chain balances.
   *
   * Nothing else populates this, and it is load-bearing in two places that
   * aren't obvious: it decides which pool sets a token's price (the deepest
   * one wins), and it gates whether a price is trusted at all. Left null, the
   * trust gate fails closed and *every* percentage change silently vanishes
   * from the table while volume and transaction counts look perfectly healthy
   * — which is exactly how this surfaced.
   *
   * Depth is measured on the priceable side and doubled, the usual convention
   * for a two-sided pool: we know the dollar value of the WETH or stable leg
   * exactly, and inferring the other leg from it adds no information.
   */
  private async refreshLiquidity(
    poolIds: number[],
    byAddress: Map<string, TrackedPool>,
    usd: Map<string, number>,
    blockNumber: bigint
  ): Promise<void> {
    if (poolIds.length === 0) return;

    const db = DatabaseService.getInstance();
    const byId = new Map([...byAddress.values()].map((p) => [p.id, p]));
    const pools = poolIds.map((id) => byId.get(id)).filter((p): p is TrackedPool => Boolean(p));
    for (const pool of pools.filter((p) => p.dexId === "uniswap-v4")) {
      try { await refreshV4Liquidity(pool, this.rpc, usd, blockNumber); }
      catch (error) { logger.warn("[indexer] V4 liquidity unavailable", { pool: pool.poolAddress, error: String(error) }); }
    }
    const ordinary = pools.filter((p) => p.dexId !== "uniswap-v4");
    const reads = ordinary.flatMap((p) => [
      { address: p.token0, abi: ERC20_ABI, functionName: "balanceOf", args: [p.poolAddress as Address] },
      { address: p.token1, abi: ERC20_ABI, functionName: "balanceOf", args: [p.poolAddress as Address] },
      { address: p.poolAddress, abi: [parseAbiItem("function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)")], functionName: "slot0" },
    ]);
    const values = await this.batchRead(reads);
    const stored = await db.prisma.indexedPool.findMany({ where: { id: { in: poolIds } }, select: { id: true, lastPrice0: true } });
    const ratios = new Map(stored.map((p) => [p.id, p.lastPrice0]));
    for (const [i, pool] of ordinary.entries()) {
      const balance0 = values[i * 3], balance1 = values[i * 3 + 1];
      if (typeof balance0 !== "bigint" || typeof balance1 !== "bigint") continue;
      const slot = values[i * 3 + 2];
      const ratio = Array.isArray(slot) && typeof slot[0] === "bigint"
        ? priceFromSqrtX96(slot[0], pool.decimals0, pool.decimals1) : ratios.get(pool.id);
      const price0 = usd.get(pool.token0) ?? (ratio && usd.has(pool.token1) ? ratio * usd.get(pool.token1)! : undefined);
      const price1 = usd.get(pool.token1) ?? (ratio && usd.has(pool.token0) ? usd.get(pool.token0)! / ratio : undefined);
      if (price0 == null || price1 == null) continue;
      const liquidityUsd = toHuman(balance0, pool.decimals0) * price0 + toHuman(balance1, pool.decimals1) * price1;
      if (!Number.isFinite(liquidityUsd) || liquidityUsd < 0) continue;
      await db.prisma.indexedPool.update({ where: { id: pool.id }, data: { liquidityUsd } });
    }
  }

  /**
   * Assigns a swap its USD volume, direction and price.
   *
   * The "quote" side is whichever token we can price in USD; the other is the
   * base. Volume is measured on the quote side because that is the leg whose
   * dollar value we actually know — converting the base leg would just be the
   * same number routed through an extra estimate.
   */
  private valueSwap(
    pool: TrackedPool,
    amount0: bigint,
    amount1: bigint,
    price0In1: number,
    usd: Map<string, number>
  ): { volumeUsd: number; isBuy: boolean; priceUsd: number } {
    const usd0 = usd.get(pool.token0);
    const usd1 = usd.get(pool.token1);

    // Quote on token1 when we can, since token0/token1 ordering is by address
    // and carries no economic meaning.
    if (usd1 !== undefined && usd1 > 0 && pool.baseToken !== pool.token1) {
      const quoteAmount = Math.abs(toHuman(amount1, pool.decimals1));
      return {
        volumeUsd: quoteAmount * usd1,
        // amount0 < 0 means token0 left the pool: the trader bought token0.
        isBuy: amount0 < 0n,
        priceUsd: price0In1 * usd1,
      };
    }

    if (usd0 !== undefined && usd0 > 0) {
      const quoteAmount = Math.abs(toHuman(amount0, pool.decimals0));
      const price1In0 = price0In1 > 0 ? 1 / price0In1 : 0;
      return {
        volumeUsd: quoteAmount * usd0,
        isBuy: amount1 < 0n,
        priceUsd: price1In0 * usd0,
      };
    }

    // Unpriceable pool. Still counted as a transaction — the txn columns are
    // about activity, not value — but it contributes no volume and no price.
    return { volumeUsd: 0, isBuy: amount0 < 0n, priceUsd: 0 };
  }

  // ─── USD anchoring ─────────────────────────────────────────────────────────

  /**
   * USD price for each priceable asset on this chain.
   *
   * Stables anchor at $1; the wrapped native is resolved by `resolveNativeUsd`,
   * which can look beyond this chain when it has to. Everything else is priced
   * transitively against those two at rollup time. Two hops is the whole depth
   * of the graph on purpose: each additional hop multiplies the error, and the
   * pools needing three hops are exactly the illiquid ones whose prices are
   * least trustworthy anyway.
   */
  private async usdPrices(pools: TrackedPool[]): Promise<Map<string, number>> {
    const usd = new Map<string, number>();
    const stables = this.stableAddresses();

    for (const stable of stables) usd.set(stable, 1);

    const wrappedNative = this.evm.wrappedNative?.toLowerCase();
    if (!wrappedNative) return usd;

    const db = DatabaseService.getInstance();
    const anchorIds = pools
      .filter(
        (p) =>
          (p.token0 === wrappedNative && stables.has(p.token1)) ||
          (p.token1 === wrappedNative && stables.has(p.token0))
      )
      .map((p) => p.id);

    const anchorPools =
      anchorIds.length > 0
        ? await db.prisma.indexedPool.findMany({
            where: { id: { in: anchorIds } },
            select: { token0: true, lastPrice0: true, liquidityUsd: true },
          })
        : [];

    const nativeUsd = await resolveNativeUsd({
      descriptor: this.descriptor,
      anchorPools,
      wrappedNative,
      stables,
    });

    if (nativeUsd != null) usd.set(wrappedNative, nativeUsd);
    const edges = await db.prisma.indexedPool.findMany({
      where: { chainId: this.chainId, lastPrice0: { gt: 0 }, liquidityUsd: { gte: 10 } },
      orderBy: { liquidityUsd: "desc" },
      select: { token0: true, token1: true, lastPrice0: true },
    });
    // Breadth-first expansion keeps each hop anchored in the previous layer.
    for (let hop = 0; hop < 3; hop++) {
      const previous = new Map(usd);
      for (const edge of edges) {
        const ratio = edge.lastPrice0!;
        if (!usd.has(edge.token0) && previous.has(edge.token1)) usd.set(edge.token0, ratio * previous.get(edge.token1)!);
        if (!usd.has(edge.token1) && previous.has(edge.token0)) usd.set(edge.token1, previous.get(edge.token0)! / ratio);
      }
    }
    return usd;
  }

  /** Curated stables on this chain, lowercased. */
  private stableAddresses(): Set<string> {
    const stableSymbols = new Set(
      [this.descriptor.stableSymbol, "USDC", "USDT", "DAI", "rUSDC", "cUSD"].map((s) =>
        s.toUpperCase()
      )
    );

    const out = new Set<string>();
    for (const [symbol, token] of Object.entries(this.evm.tokens ?? {})) {
      if (stableSymbols.has(symbol.toUpperCase())) out.add(token.address.toLowerCase());
    }
    return out;
  }

  /** Assets a pool can be quoted against: the wrapped native plus stables. */
  private priceableAddresses(): Set<string> {
    const out = this.stableAddresses();
    const wrapped = this.evm.wrappedNative?.toLowerCase();
    if (wrapped) out.add(wrapped);
    return out;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async retryPoolMetadata(): Promise<void> {
    const db = DatabaseService.getInstance().prisma;
    const pending = await db.indexedPool.findMany({
      where: { chainId: this.chainId, indexingError: { not: null } }, orderBy: { updatedAt: "asc" }, take: 50,
    });
    if (!pending.length) return;
    const decimals = await this.decimalsFor(pending.flatMap((p) => [p.token0, p.token1]));
    for (const pool of pending) {
      const d0 = decimals.get(pool.token0), d1 = decimals.get(pool.token1);
      if (d0 == null || d1 == null) {
        await db.indexedPool.update({ where: { id: pool.id }, data: { indexingError: pool.indexingError } });
        continue;
      }
      await assertIngestionLease();
      // Schedule replay before enabling the pool, so a crash cannot omit its missed interval.
      const cursor = await db.indexerCursor.findUnique({ where: { chainId: this.chainId } });
      if (cursor) {
        const floor = await this.computeBackfillFloor(cursor.lastBlock);
        const replayFrom = floor ?? (cursor.lastBlock > BigInt(this.settings.initialLookbackBlocks)
          ? cursor.lastBlock - BigInt(this.settings.initialLookbackBlocks) : 0n);
        await db.indexerCursor.update({ where: { chainId: this.chainId }, data: { lastBlock: replayFrom > 0n ? replayFrom - 1n : 0n } });
      }
      await this.catalogueTokens([{ address: pool.token0, decimals: d0 }, { address: pool.token1, decimals: d1 }]);
      await db.indexedPool.update({ where: { id: pool.id }, data: { decimals0: d0, decimals1: d1, indexingError: null } });
    }
  }

  private async trackedPools(): Promise<TrackedPool[]> {
    const db = DatabaseService.getInstance();
    const wrappedNative = this.evm.wrappedNative?.toLowerCase();
    const stables = this.stableAddresses();

    const rows = await db.prisma.indexedPool.findMany({
      where: { chainId: this.chainId, indexingError: null },
      // Most recently active first, so the cap keeps the pools that matter.
      orderBy: [{ lastSwapAt: { sort: "desc", nulls: "last" } }, { createdBlock: "desc" }],
      // Every known pool participates; address filters bound individual RPC calls.
    });

    // Anchor pools are exempt from the cap. They set the chain's USD reference,
    // so letting a quiet native/stable pair get evicted by busier ones would
    // zero out the dollar value of every swap on the chain — the cap is meant
    // to bound work, not to decide what we can price.
    if (wrappedNative && stables.size > 0) {
      const tracked = new Set(rows.map((r) => r.id));
      const anchors = await db.prisma.indexedPool.findMany({
        where: {
          chainId: this.chainId,
          indexingError: null,
          OR: [...stables].flatMap((stable) => [
            { token0: wrappedNative, token1: stable },
            { token0: stable, token1: wrappedNative },
          ]),
        },
      });

      for (const anchor of anchors) {
        if (!tracked.has(anchor.id)) rows.push(anchor);
      }
    }

    return rows.map((r) => ({
      id: r.id,
      chainId: r.chainId,
      dexId: r.dexId,
      poolAddress: r.poolAddress,
      token0: r.token0,
      token1: r.token1,
      decimals0: r.decimals0,
      decimals1: r.decimals1,
      feeTier: r.feeTier,
      baseToken: r.baseToken,
    }));
  }

  /**
   * Records a token we have seen trade.
   *
   * Writes `IndexedToken`, never `Token` — the backend's catalogue is the
   * backend's to write, and promotes from here on its own schedule. Before the
   * split this wrote `Token` directly, which meant an on-chain `symbol()` read
   * could land in the same row a curator had just edited.
   *
   * Identity only — no prices. RollupService fills the metrics in once candles
   * exist, and keeping the two separate means a token is known as soon as it is
   * seen trading rather than waiting a full window for its first rollup.
   *
   * `create`-only on conflict: re-reading identity every pass would be two RPC
   * calls per token per tick to learn something that cannot change.
   */
  private async catalogueTokens(tokens: { address: string; decimals: number }[]): Promise<void> {
    if (tokens.length === 0) return;

    const db = DatabaseService.getInstance();
    const wanted = new Map(tokens.map((t) => [t.address.toLowerCase(), t.decimals]));

    // One query for the whole batch. Asked per token this was a round trip per
    // discovered pool, almost all of which answer "already known".
    const existing = await db.prisma.indexedToken.findMany({
      where: { chainId: this.chainId, contractId: { in: [...wanted.keys()] } },
      select: { contractId: true },
    });

    for (const row of existing) wanted.delete(row.contractId.toLowerCase());
    if (wanted.size === 0) return;

    const addresses = [...wanted.keys()];

    // symbol() and name() for every new token in one batch, rather than two
    // reads each. Identity is read once and never again — `create`-only on
    // conflict — so this is the only place these calls are made.
    const results = await this.batchRead([
      ...addresses.map((address) => ({ address, abi: ERC20_ABI, functionName: "symbol" })),
      ...addresses.map((address) => ({ address, abi: ERC20_ABI, functionName: "name" })),
    ]);

    for (const [index, address] of addresses.entries()) {
      const symbol = this.cleanString(results[index]) ?? address.slice(0, 10);
      const name = this.cleanString(results[addresses.length + index]);

      // A token whose symbol can't be read isn't listable — it would render as
      // a blank row — and is overwhelmingly likely to be a broken or hostile
      // contract rather than something a user wants to trade.


      try {
        await db.prisma.indexedToken.create({
          data: {
            chainId: this.chainId,
            contractId: address,
            symbol: symbol.slice(0, 32),
            name: (name || symbol).slice(0, 128),
            decimals: wanted.get(address) ?? 18,
            dexId: this.dexId,
          },
        });
      } catch {
        // Concurrent discovery on another chain's pass can win the race; the
        // unique constraint is the arbiter and losing it is fine.
      }
    }
  }

  /**
   * Sanitises a string-returning ERC-20 field.
   *
   * Tokens exist whose "symbol" is padding or escape bytes; they render as an
   * invisible, unclickable row. Checked by code point rather than a regex
   * literal, which would otherwise embed raw control bytes in this source file.
   */
  private cleanString(value: unknown): string | null {
    if (value == null) return null;

    const text = String(value).trim();
    if (!text) return null;

    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return null;
    }

    return text;
  }

  /**
   * Decimals for a set of tokens, in one round trip where possible.
   *
   * Batched because discovery reads both sides of every new pool: a burst of
   * pool creations used to cost two sequential reads per pool on top of the
   * three per token `catalogueToken` made.
   */
  private async decimalsFor(addresses: string[]): Promise<Map<string, number>> {
    const keys = [...new Set(addresses.map((a) => a.toLowerCase()))];
    const out = new Map<string, number>();

    const unknown = keys.filter((key) => {
      const cached = this.decimalsCache.get(key);
      if (cached !== undefined) {
        out.set(key, cached);
        return false;
      }
      return true;
    });

    if (unknown.length === 0) return out;

    const results = await this.batchRead(
      unknown.map((address) => ({ address, abi: ERC20_ABI, functionName: "decimals" }))
    );

    for (const [index, address] of unknown.entries()) {
      const raw = results[index];
      // Non-standard ERC-20s exist. 18 is the right guess and a wrong guess
      // misprices one pool rather than failing the whole range.
      if (raw == null) continue;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 36) continue;
      const decimals = value;

      this.decimalsCache.set(address, decimals);
      out.set(address, decimals);
    }

    return out;
  }

  /**
   * Contract reads, batched through Multicall3 when the chain has it.
   *
   * Falls back to individual `eth_call`s on a chain without it, so this is a
   * pure optimisation rather than a new requirement on a descriptor — but
   * every chain checked so far has Multicall3 at the canonical address, so the
   * fallback is a safety net rather than an expected path.
   */
  private async batchRead(requests: MulticallRequest[]): Promise<(unknown | null)[]> {
    if (requests.length === 0) return [];

    if (await hasMulticall3(this.rpc, this.chainId)) {
      return multicallRead(this.rpc, requests);
    }

    const CONCURRENCY = 25;
    const out: (unknown | null)[] = new Array(requests.length).fill(null);

    for (let i = 0; i < requests.length; i += CONCURRENCY) {
      const slice = requests.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        slice.map(async (request) => {
          try {
            return await this.rpc.readContract({
              address: request.address as Address,
              abi: request.abi as never,
              functionName: request.functionName,
              args: request.args as never,
            });
          } catch {
            return null;
          }
        })
      );

      for (const [offset, result] of results.entries()) out[i + offset] = result;
    }

    return out;
  }

  /**
   * `eth_getLogs` with range subdivision for oversized results.
   *
   * Providers cap responses by *result count*, not block range — Robinhood's
   * public node refuses anything over 10,000 matched logs — so no fixed chunk
   * size is safe: a range that is fine on a quiet day fails during a volume
   * spike, exactly when the data matters most. Halving on that error is the
   * only reliable response.
   *
   * Crucially, only *that* error. An earlier version split on any failure,
   * reasoning that message formats vary too much to classify. That was wrong
   * in a way worth recording: against a slow endpoint it turned one timeout
   * into a recursive storm of single-block retries — thousands of requests
   * hammering a provider that was already struggling, which guaranteed the
   * timeouts continued. A timeout means "ask for less often", not "ask for
   * less, immediately, many times over".
   *
   * So: size errors subdivide; transport errors back off once and then give
   * up on the range, which the next tick will retry from the same cursor.
   * Subdivision is sequential rather than parallel for the same reason — each
   * level would otherwise double the concurrency aimed at the endpoint.
   */
  private async readSwapLogs(addresses: string[], from: bigint, to: bigint): Promise<SwapLog[]> {
    try {
      const ordinary = addresses.filter((a) => !a.includes(":"));
      const logs: SwapLog[] = ordinary.length ? await this.rpc.getLogs({ address: ordinary as Address[], events: [SWAP_EVENT, V2_SWAP_EVENT, AERO_SWAP_EVENT], fromBlock: from, toBlock: to }) as SwapLog[] : [];
      const managers = new Set(addresses.filter((a) => a.includes(":")).map((a) => a.split(":")[0]!));
      for (const manager of managers) {
        const ids = addresses.filter((a) => a.startsWith(`${manager}:`)).map((a) => a.split(":")[1] as `0x${string}`);
        const found = await this.rpc.getLogs({ address: manager as Address, event: V4_SWAP, args: { id: ids }, fromBlock: from, toBlock: to });
        for (const log of found) logs.push({ ...log, address: `${manager}:${log.args.id}`.toLowerCase() } as unknown as SwapLog);
      }
      return logs;
    } catch (error) {
      if (from !== to || addresses.length <= 1 || !isResultSetTooLarge(String(error))) throw error;
      const mid = Math.floor(addresses.length / 2);
      const left = await this.readSwapLogs(addresses.slice(0, mid), from, to);
      const right = await this.readSwapLogs(addresses.slice(mid), from, to);
      return [...left, ...right];
    }
  }

  private async getLogsAdaptive<T>(
    fetch: (from: bigint, to: bigint) => Promise<T[]>,
    from: bigint,
    to: bigint,
    depth = 0
  ): Promise<T[] | null> {
    try {
      const logs = await fetch(from, to);
      // A range this size worked, so remember it as viable. Without this the
      // window learned below would never widen again after one bad range.
      this.noteRangeWorked(to - from + 1n);
      return logs;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (isResultSetTooLarge(message) && depth < this.settings.maxSplitDepth) {
        if (to > from) {
          // Learn from the refusal before splitting. Providers that cap by
          // block range say what they will accept — Alchemy's free tier names
          // the exact window — and a cap is a property of the endpoint, not of
          // this range. Recording it means the *next* chunk is sized correctly
          // rather than rediscovering the same limit by bisection every time,
          // which on a 2,000-block chunk against a 10-block cap is over two
          // hundred requests to read what one correctly-sized request would.
          this.noteRangeRefused(message, to - from + 1n);

          const mid = from + (to - from) / 2n;
          const left = await this.getLogsAdaptive(fetch, from, mid, depth + 1);
          const right = await this.getLogsAdaptive(fetch, mid + 1n, to, depth + 1);
          // A half we couldn't read makes the whole range unknown.
          return left === null || right === null ? null : [...left, ...right];
        } else {
          logger.warn("[indexer] single block exceeds log limit; retaining cursor", {
            chainId: this.chainId,
            block: from.toString(),
          });
          return null;
        }
      }

      if (isTransient(message) && depth === 0) {
        await sleep(this.settings.retryBackoffMs);
        try {
          return await fetch(from, to);
        } catch {
          // Fall through to the give-up path below.
        }
      }

      logger.warn("[indexer] getLogs failed; range will be retried next tick", {
        chainId: this.chainId,
        from: from.toString(),
        to: to.toString(),
        depth,
        error: message.slice(0, 160),
      });
      // null, not [] — the caller must be able to tell "no swaps here" from
      // "we don't know what's here", because only the second one means the
      // cursor has to stay put.
      return null;
    }
  }

  /**
   * Splits a block range into RPC-sized windows.
   *
   * The window is the configured chunk size until the endpoint refuses one,
   * after which it is whatever the endpoint has shown it will accept.
   */
  private *chunks(from: bigint, to: bigint): Generator<[bigint, bigint]> {
    const size = this.effectiveChunkSize();
    for (let start = from; start <= to; start += size) {
      const end = start + size - 1n > to ? to : start + size - 1n;
      yield [start, end];
    }
  }

  /**
   * Blocks per `getLogs`, capped by anything the endpoint has told us.
   *
   * `INDEXER_BLOCK_CHUNK_SIZE` is a ceiling rather than a promise: an endpoint
   * with a tighter limit wins, because asking past it produces nothing but
   * refusals.
   */
  private effectiveChunkSize(): bigint {
    const configured = BigInt(this.settings.blockChunkSize);
    return this.maxBlockRange != null && this.maxBlockRange < configured
      ? this.maxBlockRange
      : configured;
  }

  /**
   * Records that the endpoint refused a range of `span` blocks.
   *
   * The provider's own suggestion is preferred when it makes one — "this block
   * range should work: [0x…, 0x…]" and "up to a 10 block range" are both
   * parsed — because it is exact. Failing that, half the refused span is the
   * same guess bisection would make, just remembered.
   */
  private noteRangeRefused(message: string, span: bigint): void {
    const learned = parseBlockRangeLimit(message) ?? (span > 1n ? span / 2n : 1n);
    if (learned <= 0n) return;

    if (this.maxBlockRange == null || learned < this.maxBlockRange) {
      this.maxBlockRange = learned;
      logger.warn("[indexer] endpoint limits getLogs range; narrowing chunks", {
        chainId: this.chainId,
        refusedSpan: span.toString(),
        blockChunkSize: learned.toString(),
        configured: this.settings.blockChunkSize,
        hint:
          learned < 100n
            ? "This endpoint's block-range cap makes catch-up very slow — a paid RPC tier is likely required."
            : undefined,
      });
    }
  }

  /**
   * Records a span the endpoint accepted.
   *
   * Only ever widens, and in practice rarely does: once the window has
   * narrowed, `chunks()` stops asking for anything larger, so there is nothing
   * to observe succeeding. That is the conservative direction — a limit is a
   * property of the plan you are on, and guessing it has lifted costs a wasted
   * round trip per chunk. Restart the process after upgrading a tier.
   */
  private noteRangeWorked(span: bigint): void {
    if (this.maxBlockRange != null && span > this.maxBlockRange) {
      this.maxBlockRange = span;
    }
  }

  private chunkArray<T>(items: T[], size: number): T[][] {
    if (items.length <= size) return [items];
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  private async saveCursor(data: {
    lastBlock?: bigint;
    lastPoolBlock?: bigint;
    backfillBlock?: bigint;
    backfillFloor?: bigint;
    backfillDone?: boolean;
  }): Promise<void> {
    const db = DatabaseService.getInstance();
    const forwardState = data.lastBlock != null ? await evmCheckpoint(this.chainId, data.lastBlock, this.rpc) : undefined;
    await assertIngestionLease();
    await db.prisma.indexerCursor.upsert({
      where: { chainId: this.chainId },
      create: {
        chainId: this.chainId,
        lastBlock: data.lastBlock ?? 0n,
        lastPoolBlock: data.lastPoolBlock ?? null,
      },
      update: { ...data, ...(forwardState ? { forwardState } : {}) },
    });
  }
}
