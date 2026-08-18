import { parseAbiItem, type Address, type PublicClient } from "viem";
import { DatabaseService } from "../../db.js";
import { batchingPublicClientFor } from "../../chains/evm/evmClient.js";
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

/**
 * "Your query matched too much" — the one error subdivision actually fixes.
 * Wordings differ per provider, so this matches the shapes seen in the wild.
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

  constructor(
    private readonly descriptor: ChainDescriptor,
    private readonly settings: IndexerSettings
  ) {
    this.chainId = descriptor.chainId;
    this.evm = requireEvmConfig(descriptor);

    if (!this.evm.dex?.factory) {
      throw new Error(
        `Chain ${descriptor.chainId} has no DEX factory configured — it cannot be indexed`
      );
    }
  }

  /** Whether a descriptor can back an indexer at all. */
  static canIndex(descriptor: ChainDescriptor): boolean {
    return descriptor.family === "evm" && Boolean(descriptor.evm?.dex?.factory);
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

  async run(): Promise<IndexRunResult> {
    const db = DatabaseService.getInstance();
    const head = await this.rpc.getBlockNumber();

    // Never ingest into the reorg window.
    const safeHead = head > BigInt(this.settings.confirmations)
      ? head - BigInt(this.settings.confirmations)
      : 0n;

    const cursor = await db.prisma.indexerCursor.findUnique({
      where: { chainId: this.chainId },
    });

    // A fresh chain starts near the head rather than at genesis. Backfilling
    // years of logs on first boot would stall the cycle indefinitely and is
    // not what the discovery pages need — they want what is trading *now*.
    const defaultStart =
      safeHead > BigInt(this.settings.initialLookbackBlocks)
        ? safeHead - BigInt(this.settings.initialLookbackBlocks)
        : 0n;

    const fromBlock = cursor ? cursor.lastBlock + 1n : defaultStart;
    const poolFromBlock = cursor?.lastPoolBlock != null ? cursor.lastPoolBlock + 1n : defaultStart;

    // Seed the row up front so neither pass can create it with a placeholder
    // height. Pool discovery used to write the row first with lastBlock left
    // at its default of 0, which sent swap ingestion back to block 1 to crawl
    // forward `maxBlocksPerRun` at a time — on a chain 26M blocks deep it
    // would never have reached the head, and it looked like "no swaps found"
    // rather than like a bug.
    if (!cursor) {
      const seed = defaultStart > 0n ? defaultStart - 1n : 0n;
      await db.prisma.indexerCursor.create({
        // backfillBlock is seeded here, not lazily on the first backfill tick.
        // By then lastBlock has advanced to the head, and a walk starting from
        // there would descend through blocks the forward pass already
        // ingested — inflating additively-accumulated volume permanently.
        data: {
          chainId: this.chainId,
          lastBlock: seed,
          lastPoolBlock: seed,
          backfillBlock: seed,
        },
      });
    }

    if (fromBlock > safeHead) {
      return {
        chainId: this.chainId,
        poolsDiscovered: 0,
        swapsIngested: 0,
        bucketsWritten: 0,
        fromBlock,
        toBlock: safeHead,
      };
    }

    // One tick processes at most maxBlocksPerRun. A chain that has fallen far
    // behind catches up over several ticks instead of blocking one for minutes.
    const toBlock =
      safeHead - fromBlock > BigInt(this.settings.maxBlocksPerRun)
        ? fromBlock + BigInt(this.settings.maxBlocksPerRun)
        : safeHead;

    const poolsDiscovered = await this.discoverPools(poolFromBlock, toBlock);
    const { swapsIngested, bucketsWritten } = await this.ingestSwaps(fromBlock, toBlock);

    // Backfill only once the forward pass has reached the head. Live data is
    // what the product is for; history is a correctness nicety, and a chain
    // catching up must not spend half its block budget walking backwards.
    const backfilled =
      toBlock >= safeHead ? await this.backfillStep(safeHead) : { swapsIngested: 0, bucketsWritten: 0 };

    return {
      chainId: this.chainId,
      poolsDiscovered,
      swapsIngested: swapsIngested + backfilled.swapsIngested,
      bucketsWritten: bucketsWritten + backfilled.bucketsWritten,
      fromBlock,
      toBlock,
    };
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
    const factory = this.evm.dex!.factory as Address;
    const priceable = this.priceableAddresses();

    let discovered = 0;
    let poolScanFailed = false;

    for (const [start, end] of this.chunks(fromBlock, toBlock)) {
      const logs = await this.getLogsAdaptive(
        (from, to) =>
          this.rpc.getLogs({
            address: factory,
            event: POOL_CREATED_EVENT,
            fromBlock: from,
            toBlock: to,
          }),
        start,
        end
      );

      // Discovery is allowed to skip an unreadable chunk. Unlike swaps, a
      // missed pool is self-healing: the pool is rediscovered the moment
      // `lastPoolBlock` is retried, and until then its swaps simply aren't
      // tracked — nothing is miscounted in the meantime.
      if (logs === null) {
        poolScanFailed = true;
        continue;
      }

      for (const log of logs) {
        const { token0: t0, token1: t1, fee, pool: poolAddress } = log.args;
        if (!t0 || !t1 || !poolAddress) continue;

        const token0 = t0.toLowerCase();
        const token1 = t1.toLowerCase();
        const feeTier = fee === undefined ? null : Number(fee);

        // Only pools with a priceable side are worth ingesting — the other
        // side is what gives every swap a USD value.
        if (!priceable.has(token0) && !priceable.has(token1)) continue;

        const pool = poolAddress.toLowerCase();
        // The quote side is the one we can price; the base is what the pool is
        // actually about. Every downstream metric is attributed to the base.
        const quoteToken = priceable.has(token1) ? token1 : token0;
        const baseToken = quoteToken === token0 ? token1 : token0;

        const [decimals0, decimals1] = await Promise.all([
          this.decimalsOf(token0),
          this.decimalsOf(token1),
        ]);

        try {
          await db.prisma.indexedPool.upsert({
            where: { chainId_poolAddress: { chainId: this.chainId, poolAddress: pool } },
            create: {
              chainId: this.chainId,
              dexId: this.dexId,
              poolAddress: pool,
              token0,
              token1,
              decimals0,
              decimals1,
              baseToken,
              quoteToken,
              feeTier,
              createdBlock: log.blockNumber ?? null,
              pairCreatedAt: new Date(),
            },
            // A rediscovered pool keeps its original creation data; only the
            // token metadata could have been wrong (unreadable decimals).
            update: { decimals0, decimals1, baseToken, quoteToken },
          });
          // Catalogue the traded side so discovery can list it.
          //
          // Without this the catalogue only ever contains the handful of tokens
          // hardcoded in the descriptor, because that is all
          // `getSwappableTokens` knows about — and the entire point of an
          // indexer is the long tail that wasn't hardcoded anywhere. The
          // priceable side (WETH, a stable) is skipped: it's already curated.
          await this.catalogueToken(baseToken, baseToken === token0 ? decimals0 : decimals1);

          discovered++;
        } catch (error) {
          logger.warn("[indexer] pool upsert failed", {
            chainId: this.chainId,
            pool,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Only claim the scanned range if all of it was actually readable.
    if (!poolScanFailed) await this.saveCursor({ lastPoolBlock: toBlock });
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

    if (pools.length === 0) {
      // Nothing to read. Claim the range anyway: re-walking it next tick would
      // find the same nothing, and on a chain with no tracked pools that loop
      // never terminates.
      await this.saveCursor(
        direction === "forward" ? { lastBlock: toBlock } : { backfillBlock: fromBlock }
      );
      return { swapsIngested: 0, bucketsWritten: 0 };
    }

    const byAddress = new Map(pools.map((p) => [p.poolAddress.toLowerCase(), p]));
    const usd = await this.usdPrices(pools);
    const rawSwaps: RawSwap[] = [];
    const poolState = new Map<number, { price: number; at: Date }>();

    // Primed once for the whole range: a bounded number of samples, rather
    // than a lookup per block, is what keeps ingestion O(1) in range size.
    const clock = new BlockTimeOracle(this.rpc);
    await clock.prime(fromBlock, toBlock);

    let swapsIngested = 0;
    /** First block of the earliest unreadable chunk; the cursor stops before it. */
    let failedAt: bigint | null = null;

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
              this.rpc.getLogs({
                address: addresses as Address[],
                event: SWAP_EVENT,
                fromBlock: from,
                toBlock: to,
              }),
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

      const logs = fetched.flat().filter((l) => l !== null);
      if (logs.length === 0) continue;

      // Block order matters: `open` is the first price written to a bucket
      // and `close` the last, so out-of-order application inverts both.
      logs.sort((a, b) => {
        const blockDelta = Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n));
        return blockDelta !== 0 ? blockDelta : (a.logIndex ?? 0) - (b.logIndex ?? 0);
      });

      for (const log of logs) {
        const pool = byAddress.get(log.address.toLowerCase());
        if (!pool) continue;

        const { amount0, amount1, sqrtPriceX96, recipient, sender } = log.args;
        if (amount0 === undefined || amount1 === undefined || sqrtPriceX96 === undefined) {
          continue;
        }

        const traderAddress = (recipient ?? sender ?? "").toLowerCase();
        const timestamp = log.blockNumber != null ? clock.timeOf(log.blockNumber) : Date.now();
        const price0In1 = priceFromSqrtX96(sqrtPriceX96, pool.decimals0, pool.decimals1);

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
    }

    // Swaps are stored and the buckets they touch are recomputed from
    // storage. The cursor move below no longer has to share a transaction with
    // this for correctness — a replay is a no-op — but it still commits with
    // the pool-state writes, which are last-write-wins.
    const bucketsWritten = await persistSwaps(rawSwaps);

    // Commit only as far as we actually read. If a chunk was unreadable the
    // cursor stops at the block before it, so the gap is re-attempted rather
    // than skipped — and because the candle write and the cursor move commit
    // together, the blocks we do claim are exactly the blocks we ingested.
    const committedTo = failedAt != null ? failedAt - 1n : toBlock;

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
        : { backfillBlock: failedAt != null ? failedAt + 1n : fromBlock };

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

    await db.prisma.$transaction([
      ...poolStateWrites,
      db.prisma.indexerCursor.upsert({
        where: { chainId: this.chainId },
        create: { chainId: this.chainId, lastBlock: committedTo, lastPoolBlock: committedTo },
        update: cursorMove,
      }),
    ]);

    // Liquidity is refreshed only for pools that actually traded. It costs two
    // balance reads per pool, and a pool with no swaps this tick has neither
    // moved nor become more interesting. Skipped entirely on backfill: the
    // reads return *today's* balances, so attributing them to a pool because
    // of a trade last week is both wrong and paid for in RPC calls.
    if (direction === "forward") {
      await this.refreshLiquidity([...poolState.keys()], byAddress, usd);
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
    usd: Map<string, number>
  ): Promise<void> {
    if (poolIds.length === 0) return;

    const db = DatabaseService.getInstance();
    const byId = new Map([...byAddress.values()].map((p) => [p.id, p]));

    const updates: { id: number; liquidityUsd: number }[] = [];
    const CONCURRENCY = 25;

    for (let i = 0; i < poolIds.length; i += CONCURRENCY) {
      const slice = poolIds.slice(i, i + CONCURRENCY);

      const measured = await Promise.all(
        slice.map(async (id) => {
          const pool = byId.get(id);
          if (!pool) return null;

          // Whichever side we can price; if both, prefer token1 for symmetry
          // with valueSwap.
          const usd1 = usd.get(pool.token1);
          const usd0 = usd.get(pool.token0);

          const quote =
            usd1 && usd1 > 0
              ? { token: pool.token1, decimals: pool.decimals1, price: usd1 }
              : usd0 && usd0 > 0
                ? { token: pool.token0, decimals: pool.decimals0, price: usd0 }
                : null;

          if (!quote) return null;

          try {
            const balance = await this.rpc.readContract({
              address: quote.token as Address,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [pool.poolAddress as Address],
            });

            const value = toHuman(balance as bigint, quote.decimals) * quote.price;
            if (!Number.isFinite(value) || value < 0) return null;

            return { id, liquidityUsd: value * 2 };
          } catch {
            return null;
          }
        })
      );

      for (const m of measured) {
        if (m) updates.push(m);
      }
    }

    if (updates.length === 0) return;

    await db.prisma.$transaction(
      updates.map((u) =>
        db.prisma.indexedPool.update({
          where: { id: u.id },
          data: { liquidityUsd: u.liquidityUsd },
        })
      )
    );
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
    if (usd1 !== undefined && usd1 > 0) {
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

  private async trackedPools(): Promise<TrackedPool[]> {
    const db = DatabaseService.getInstance();
    const wrappedNative = this.evm.wrappedNative?.toLowerCase();
    const stables = this.stableAddresses();

    const rows = await db.prisma.indexedPool.findMany({
      where: { chainId: this.chainId },
      // Most recently active first, so the cap keeps the pools that matter.
      orderBy: [{ lastSwapAt: { sort: "desc", nulls: "last" } }, { createdBlock: "desc" }],
      take: this.settings.maxPools,
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
  private async catalogueToken(address: string, decimals: number): Promise<void> {
    const db = DatabaseService.getInstance();

    const existing = await db.prisma.indexedToken.findUnique({
      where: { chainId_contractId: { chainId: this.chainId, contractId: address } },
      select: { id: true },
    });
    if (existing) return;

    const [symbol, name] = await Promise.all([
      this.stringField(address, "symbol"),
      this.stringField(address, "name"),
    ]);

    // A token whose symbol can't be read isn't listable — it would render as a
    // blank row — and is overwhelmingly likely to be a broken or hostile
    // contract rather than something a user wants to trade.
    if (!symbol) return;

    try {
      await db.prisma.indexedToken.create({
        data: {
          chainId: this.chainId,
          contractId: address,
          symbol: symbol.slice(0, 32),
          name: (name || symbol).slice(0, 128),
          decimals,
          dexId: this.dexId,
        },
      });
    } catch {
      // Concurrent discovery on another chain's pass can win the race; the
      // unique constraint is the arbiter and losing it is fine.
    }
  }

  /** Reads an optional string-returning ERC-20 field. */
  private async stringField(address: string, field: "symbol" | "name"): Promise<string | null> {
    try {
      const value = await this.rpc.readContract({
        address: address as Address,
        abi: ERC20_ABI,
        functionName: field,
      });
      const text = String(value).trim();
      if (!text) return null;

      // Reject control characters. Tokens exist whose "symbol" is padding or
      // escape bytes; they render as an invisible, unclickable row. Checked by
      // code point rather than a regex literal, which would otherwise embed
      // raw control bytes in this source file.
      for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) return null;
      }

      return text;
    } catch {
      return null;
    }
  }

  private async decimalsOf(address: string): Promise<number> {
    const key = address.toLowerCase();
    const cached = this.decimalsCache.get(key);
    if (cached !== undefined) return cached;

    try {
      const decimals = await this.rpc.readContract({
        address: key as Address,
        abi: ERC20_ABI,
        functionName: "decimals",
      });
      const value = Number(decimals);
      this.decimalsCache.set(key, value);
      return value;
    } catch {
      // Non-standard ERC-20s exist. 18 is the right guess and a wrong guess
      // misprices one pool rather than failing the whole range.
      this.decimalsCache.set(key, 18);
      return 18;
    }
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
  private async getLogsAdaptive<T>(
    fetch: (from: bigint, to: bigint) => Promise<T[]>,
    from: bigint,
    to: bigint,
    depth = 0
  ): Promise<T[] | null> {
    try {
      return await fetch(from, to);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (isResultSetTooLarge(message) && to > from && depth < this.settings.maxSplitDepth) {
        const mid = from + (to - from) / 2n;
        const left = await this.getLogsAdaptive(fetch, from, mid, depth + 1);
        const right = await this.getLogsAdaptive(fetch, mid + 1n, to, depth + 1);
        // A half we couldn't read makes the whole range unknown.
        return left === null || right === null ? null : [...left, ...right];
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

  /** Splits a block range into RPC-sized windows. */
  private *chunks(from: bigint, to: bigint): Generator<[bigint, bigint]> {
    const size = BigInt(this.settings.blockChunkSize);
    for (let start = from; start <= to; start += size) {
      const end = start + size - 1n > to ? to : start + size - 1n;
      yield [start, end];
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
    await db.prisma.indexerCursor.upsert({
      where: { chainId: this.chainId },
      create: {
        chainId: this.chainId,
        lastBlock: data.lastBlock ?? 0n,
        lastPoolBlock: data.lastPoolBlock ?? null,
      },
      update: data,
    });
  }
}
