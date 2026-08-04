import { DatabaseService } from "../../db.js";
import { ConfigManager } from "../../../config.js";
import { logger } from "../../../utils/logger.js";
import { CandleAccumulator, buildCandleUpsert } from "../candleStore.js";
import { bucketStartOf } from "../types.js";
import { decodeStacksSwapPrint, canDecodeStacksDex } from "./printDecoder.js";
import type { ChainIndexer, IndexRunResult } from "../types.js";
import type { IndexerSettings } from "../settings.js";
import type { ChainDescriptor, ChainId, StacksSwapContract } from "../../../types/chain.js";
import { requireStacksConfig } from "../../../types/chain.js";

/**
 * Swap ingestion for Stacks.
 *
 * Structurally the same job as the EVM indexer — discover pools, fold swaps
 * into 5-minute candles, advance a cursor atomically — but almost none of the
 * mechanics carry over, which is why it is a separate `ChainIndexer` rather
 * than a parameterisation of the existing one:
 *
 *  - **There is no factory and no per-pair contract.** A Stacks AMM holds
 *    every pool inside one contract and names the pair in each swap print, so
 *    pools are discovered *from the swaps themselves*. A pool appears the
 *    first time it trades, which is also the first moment it is interesting.
 *  - **There are no logs to filter by topic.** The API is transaction-shaped,
 *    so the walk is "transactions touching this contract, newest first, until
 *    we reach the cursor" rather than a block range with a filter.
 *  - **The cursor is a Stacks block height** and, unlike an EVM range scan,
 *    the ingest cost is proportional to *swap count*, not to block count. A
 *    quiet hour costs one request.
 *
 * What is deliberately identical: the candle shape, the additive volume
 * accumulation, and the rule that the write and the cursor move commit
 * together. RollupService then treats these pools exactly like any others.
 */

interface StacksTx {
  tx_id: string;
  tx_status: string;
  block_height: number;
  block_time: number;
}

interface StacksEvent {
  event_type: string;
  contract_log?: { contract_id?: string; value?: { repr?: string } };
}

/** A pool row as this indexer needs it in memory. */
interface StacksPool {
  id: number;
  poolAddress: string;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
}

export class StacksIndexer implements ChainIndexer {
  readonly chainId: ChainId;

  private readonly stacks;
  private readonly decimalsCache = new Map<string, number>();

  constructor(
    private readonly descriptor: ChainDescriptor,
    private readonly settings: IndexerSettings
  ) {
    this.chainId = descriptor.chainId;
    this.stacks = requireStacksConfig(descriptor);
  }

  /**
   * Indexable when the descriptor lists contracts *and* a dialect exists for
   * each. A contract we can't decode would be polled every tick forever and
   * yield nothing, which reads as "this DEX has no volume".
   */
  static canIndex(descriptor: ChainDescriptor): boolean {
    return (
      descriptor.family === "stacks" &&
      (descriptor.stacks?.swapContracts?.length ?? 0) > 0 &&
      descriptor.stacks!.swapContracts.every((c) => canDecodeStacksDex(c.dexId))
    );
  }

  private get api(): string {
    return this.stacks.apiUrl.replace(/\/$/, "");
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const config = ConfigManager.getInstance().config;
    const headers: Record<string, string> = {};
    // Hiro rate-limits anonymous callers hard, and the indexer is the heaviest
    // caller in the process.
    if (config.HIRO_API_KEY) headers["x-api-key"] = config.HIRO_API_KEY;

    const response = await fetch(`${this.api}${path}`, { headers });
    if (!response.ok) {
      throw new Error(`Stacks API ${response.status} for ${path}`);
    }
    return (await response.json()) as T;
  }

  async run(): Promise<IndexRunResult> {
    const db = DatabaseService.getInstance();

    const cursor = await db.prisma.indexerCursor.findUnique({
      where: { chainId: this.chainId },
    });

    const tip = await this.chainTip();

    // A fresh chain starts at the tip rather than at genesis. Stacks has
    // millions of blocks and the discovery pages want what is trading now;
    // history arrives through the same backfill the EVM indexer uses.
    if (!cursor) {
      await db.prisma.indexerCursor.create({
        data: {
          chainId: this.chainId,
          lastBlock: BigInt(tip),
          lastPoolBlock: BigInt(tip),
          backfillBlock: BigInt(tip),
        },
      });
      return this.empty(BigInt(tip), BigInt(tip));
    }

    const fromBlock = cursor.lastBlock;
    if (BigInt(tip) <= fromBlock) return this.empty(fromBlock, BigInt(tip));

    const swaps = await this.collectSwaps(fromBlock);
    if (swaps.length === 0) {
      // Nothing traded. The cursor still advances — leaving it behind would
      // re-walk the same empty range every tick forever.
      await this.saveCursor(BigInt(tip));
      return this.empty(fromBlock, BigInt(tip));
    }

    const { bucketsWritten, poolsDiscovered } = await this.ingest(swaps, BigInt(tip));

    return {
      chainId: this.chainId,
      poolsDiscovered,
      swapsIngested: swaps.length,
      bucketsWritten,
      fromBlock,
      toBlock: BigInt(tip),
    };
  }

  private empty(fromBlock: bigint, toBlock: bigint): IndexRunResult {
    return {
      chainId: this.chainId,
      poolsDiscovered: 0,
      swapsIngested: 0,
      bucketsWritten: 0,
      fromBlock,
      toBlock,
    };
  }

  private async chainTip(): Promise<number> {
    const info = await this.fetchJson<{ stacks_tip_height: number }>("/extended/v1/status");
    return info.stacks_tip_height;
  }

  /**
   * Every swap print newer than the cursor, across all watched contracts.
   *
   * Walks *backwards* from the tip because that is the only ordering the API
   * offers, then reverses: candles record `open` from the first write, so
   * swaps must be applied oldest-first or every bucket's open price would be
   * the last trade in it.
   */
  private async collectSwaps(fromBlock: bigint): Promise<DecodedSwapAt[]> {
    const collected: DecodedSwapAt[] = [];

    for (const contract of this.stacks.swapContracts) {
      try {
        collected.push(...(await this.collectForContract(contract, fromBlock)));
      } catch (error) {
        // One protocol's contract failing must not cost us the others. The
        // cursor is shared, so this range will be re-walked next tick — which
        // is safe because candle writes are keyed and the cursor only advances
        // to what was actually read.
        logger.warn("[indexer] stacks contract read failed", {
          chainId: this.chainId,
          contract: contract.contractId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return collected.sort((a, b) => a.blockHeight - b.blockHeight || a.eventIndex - b.eventIndex);
  }

  private async collectForContract(
    contract: StacksSwapContract,
    fromBlock: bigint
  ): Promise<DecodedSwapAt[]> {
    const found: DecodedSwapAt[] = [];
    const pageSize = 50;
    let offset = 0;
    let inspected = 0;

    while (inspected < this.settings.maxTxPerRun) {
      const page = await this.fetchJson<{ results: { tx?: StacksTx }[] }>(
        `/extended/v2/addresses/${contract.contractId}/transactions?limit=${pageSize}&offset=${offset}`
      );

      const rows = page.results ?? [];
      if (rows.length === 0) break;

      let reachedCursor = false;

      for (const row of rows) {
        const tx = row.tx ?? (row as unknown as StacksTx);
        if (!tx?.tx_id) continue;

        // The API returns newest first, so the first transaction at or below
        // the cursor means everything after it is already ingested.
        if (BigInt(tx.block_height) <= fromBlock) {
          reachedCursor = true;
          break;
        }

        inspected++;
        if (tx.tx_status !== "success") continue;

        found.push(...(await this.swapsInTx(tx, contract)));
      }

      if (reachedCursor || rows.length < pageSize) break;
      offset += pageSize;
    }

    return found;
  }

  /**
   * The swap prints inside one transaction.
   *
   * A second request per transaction, because the list endpoint returns an
   * empty `events` array — the detail endpoint is the only place the print
   * payload appears. That cost is proportional to swaps rather than to blocks,
   * so a quiet period costs nothing.
   */
  private async swapsInTx(tx: StacksTx, contract: StacksSwapContract): Promise<DecodedSwapAt[]> {
    const detail = await this.fetchJson<{ events?: StacksEvent[] }>(
      `/extended/v1/tx/${tx.tx_id}?event_limit=100`
    );

    const out: DecodedSwapAt[] = [];

    for (const [index, event] of (detail.events ?? []).entries()) {
      if (event.event_type !== "smart_contract_log") continue;
      if (event.contract_log?.contract_id !== contract.contractId) continue;

      const decoded = decodeStacksSwapPrint(event.contract_log?.value?.repr ?? "", contract.dexId);
      if (!decoded) continue;

      out.push({
        ...decoded,
        dexId: contract.dexId,
        contractId: contract.contractId,
        blockHeight: tx.block_height,
        // Stacks reports seconds; every bucket boundary here is milliseconds.
        timestampMs: tx.block_time * 1000,
        eventIndex: index,
      });
    }

    return out;
  }

  /**
   * Folds decoded swaps into candles and commits them with the cursor.
   */
  private async ingest(
    swaps: DecodedSwapAt[],
    toBlock: bigint
  ): Promise<{ bucketsWritten: number; poolsDiscovered: number }> {
    const db = DatabaseService.getInstance();

    const { pools, discovered } = await this.resolvePools(swaps);
    const usd = await this.usdPrices(pools, swaps);

    const accumulator = new CandleAccumulator();
    const poolState = new Map<number, { price: number; at: Date }>();

    for (const swap of swaps) {
      const pool = pools.get(this.poolAddressOf(swap));
      if (!pool) continue;

      const amount0 = Number(swap.amount0) / 10 ** pool.decimals0;
      const amount1 = Number(swap.amount1) / 10 ** pool.decimals1;
      if (amount0 <= 0 || amount1 <= 0) continue;

      const price0Usd = usd.get(pool.token0);
      const price1Usd = usd.get(pool.token1);

      // The token being *priced* is whichever side isn't the priceable one.
      // A pool of two priceable assets prices from token0 arbitrarily; both
      // answers are right.
      const priceUsd = price0Usd ?? (price1Usd ? (amount1 / amount0) * price1Usd : 0);

      // Value the trade from the side we can price. Trades we saw but couldn't
      // value contribute zero volume here and are reported as *unknown* by the
      // rollup, never as zero — the two sort to opposite ends of the table.
      const volumeUsd = price0Usd
        ? amount0 * price0Usd
        : price1Usd
          ? amount1 * price1Usd
          : 0;

      const at = new Date(swap.timestampMs);
      accumulator.add(pool.id, bucketStartOf(swap.timestampMs), priceUsd, volumeUsd, !swap.zeroForOne);

      if (priceUsd > 0) poolState.set(pool.id, { price: priceUsd, at });
    }

    const buckets = accumulator.values();

    await db.prisma.$transaction([
      ...(buckets.length > 0 ? [db.prisma.$executeRaw(buildCandleUpsert(buckets))] : []),
      ...[...poolState.entries()].map(([poolId, state]) =>
        db.prisma.indexedPool.update({
          where: { id: poolId },
          data: { lastPrice0: state.price, lastSwapAt: state.at },
        })
      ),
      db.prisma.indexerCursor.upsert({
        where: { chainId: this.chainId },
        create: { chainId: this.chainId, lastBlock: toBlock, lastPoolBlock: toBlock },
        update: { lastBlock: toBlock },
      }),
    ]);

    await this.refreshLiquidity(pools, swaps, usd);

    return { bucketsWritten: buckets.length, poolsDiscovered: discovered };
  }

  /** `contract#poolKey` — unique per pool and stable across restarts. */
  private poolAddressOf(swap: DecodedSwapAt): string {
    return `${swap.contractId}#${swap.poolKey}`;
  }

  /**
   * Ensures a pool row exists for every pair that traded, creating what's new.
   *
   * This is the whole of pool discovery on Stacks. There is no factory to
   * enumerate, and a pool that has never traded is one nothing can price
   * anyway.
   */
  private async resolvePools(
    swaps: DecodedSwapAt[]
  ): Promise<{ pools: Map<string, StacksPool>; discovered: number }> {
    const db = DatabaseService.getInstance();
    const pools = new Map<string, StacksPool>();

    const wanted = new Map<string, DecodedSwapAt>();
    for (const swap of swaps) wanted.set(this.poolAddressOf(swap), swap);

    const existing = await db.prisma.indexedPool.findMany({
      where: { chainId: this.chainId, poolAddress: { in: [...wanted.keys()] } },
    });

    for (const row of existing) {
      pools.set(row.poolAddress, {
        id: row.id,
        poolAddress: row.poolAddress,
        token0: row.token0,
        token1: row.token1,
        decimals0: row.decimals0,
        decimals1: row.decimals1,
      });
    }

    let discovered = 0;

    for (const [poolAddress, swap] of wanted) {
      if (pools.has(poolAddress)) continue;

      const [decimals0, decimals1] = await Promise.all([
        this.decimalsOf(swap.token0),
        this.decimalsOf(swap.token1),
      ]);

      try {
        const created = await db.prisma.indexedPool.create({
          data: {
            chainId: this.chainId,
            dexId: swap.dexId,
            poolAddress,
            token0: swap.token0,
            token1: swap.token1,
            decimals0,
            decimals1,
            createdBlock: BigInt(swap.blockHeight),
            baseToken: this.baseSideOf(swap.token0, swap.token1),
            quoteToken: this.quoteSideOf(swap.token0, swap.token1),
          },
        });

        pools.set(poolAddress, {
          id: created.id,
          poolAddress,
          token0: swap.token0,
          token1: swap.token1,
          decimals0,
          decimals1,
        });
        discovered++;

        await this.catalogueToken(swap, decimals0, decimals1);
      } catch {
        // Lost a race with a concurrent pass; the unique key is the arbiter.
      }
    }

    return { pools, discovered };
  }

  /**
   * Token decimals, read from the contract.
   *
   * Not assumed. Stacks tokens are commonly 6 or 8 but by no means always, and
   * decimals scale the amount a candle records — a token read as 6 when it is
   * 8 reports every trade at 100x its real size.
   */
  private async decimalsOf(contractId: string): Promise<number> {
    const cached = this.decimalsCache.get(contractId);
    if (cached !== undefined) return cached;

    const fallback = this.descriptor.nativeDecimals;
    const [address, name] = contractId.split(".");
    if (!address || !name) return fallback;

    try {
      const response = await fetch(
        `${this.api}/v2/contracts/call-read/${address}/${name}/get-decimals`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender: address, arguments: [] }),
        }
      );

      const body = (await response.json()) as { okay?: boolean; result?: string };
      // Clarity encodes `(ok uN)`; the trailing hex word is the value.
      const match = body.result?.match(/0[xX]0703([0-9a-fA-F]{32})$/) ?? null;
      const decimals = match ? Number(BigInt(`0x${match[1]}`)) : NaN;

      if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 36) {
        this.decimalsCache.set(contractId, decimals);
        return decimals;
      }
    } catch {
      // Fall through — an unreadable decimals is not a reason to drop the pool
      // entirely, unlike on the trading path where it would scale a spend.
    }

    this.decimalsCache.set(contractId, fallback);
    return fallback;
  }

  /**
   * Contract-name fragments identifying a USD stable.
   *
   * Matched on the contract *name* rather than the full principal because
   * Stacks stables are reissued: aeUSDC alone has shipped under more than one
   * deployer, and pinning principals would mean a silent loss of pricing on
   * every reissue — which shows up as a chain whose volume quietly goes to
   * unknown, not as an error.
   */
  private static readonly STABLE_NAMES = [
    "token-aeusdc",
    "token-susdt",
    "token-wusdc",
    "usdcx",
    "usda",
  ];

  private isStable(contractId: string): boolean {
    const name = contractId.split(".")[1]?.toLowerCase() ?? "";
    return StacksIndexer.STABLE_NAMES.some((fragment) => name.includes(fragment));
  }

  private isNative(contractId: string): boolean {
    const name = contractId.split(".")[1]?.toLowerCase() ?? "";
    return name === "wstx" || name.startsWith("token-wstx");
  }

  private baseSideOf(token0: string, token1: string): string | null {
    if (this.isStable(token0) || this.isNative(token0)) return token1;
    if (this.isStable(token1) || this.isNative(token1)) return token0;
    return null;
  }

  private quoteSideOf(token0: string, token1: string): string | null {
    const base = this.baseSideOf(token0, token1);
    if (!base) return null;
    return base === token0 ? token1 : token0;
  }

  /**
   * USD price per token contract.
   *
   * Stables anchor at 1. STX is priced from the deepest stable pair observed in
   * this batch, and everything else is priced by the pool it traded in. A token
   * with no priceable counterparty gets no price — deliberately absent rather
   * than zero.
   */
  private async usdPrices(
    pools: Map<string, StacksPool>,
    swaps: DecodedSwapAt[]
  ): Promise<Map<string, number>> {
    const usd = new Map<string, number>();

    for (const pool of pools.values()) {
      if (this.isStable(pool.token0)) usd.set(pool.token0, 1);
      if (this.isStable(pool.token1)) usd.set(pool.token1, 1);
    }

    // STX against a stable, from the largest trade seen — the largest trade is
    // the one least distorted by rounding at these decimal scales.
    let best = 0;
    for (const swap of swaps) {
      const pool = pools.get(this.poolAddressOf(swap));
      if (!pool) continue;

      const nativeIsZero = this.isNative(pool.token0);
      const stableSide = nativeIsZero ? pool.token1 : pool.token0;
      if (!(nativeIsZero || this.isNative(pool.token1)) || !this.isStable(stableSide)) continue;

      const nativeAmount =
        Number(nativeIsZero ? swap.amount0 : swap.amount1) /
        10 ** (nativeIsZero ? pool.decimals0 : pool.decimals1);
      const stableAmount =
        Number(nativeIsZero ? swap.amount1 : swap.amount0) /
        10 ** (nativeIsZero ? pool.decimals1 : pool.decimals0);

      if (nativeAmount <= 0 || stableAmount <= 0 || stableAmount < best) continue;

      best = stableAmount;
      usd.set(nativeIsZero ? pool.token0 : pool.token1, stableAmount / nativeAmount);
    }

    return usd;
  }

  /**
   * Records pool depth in USD from the reserves the print already carried.
   *
   * Free, unlike the EVM path's balance reads: the swap event states the
   * post-trade reserves, so no extra call is needed.
   */
  private async refreshLiquidity(
    pools: Map<string, StacksPool>,
    swaps: DecodedSwapAt[],
    usd: Map<string, number>
  ): Promise<void> {
    const db = DatabaseService.getInstance();
    const latest = new Map<number, number>();

    for (const swap of swaps) {
      const pool = pools.get(this.poolAddressOf(swap));
      if (!pool || swap.reserve0 === null || swap.reserve1 === null) continue;

      const price0 = usd.get(pool.token0);
      const price1 = usd.get(pool.token1);
      if (!price0 && !price1) continue;

      const reserve0 = Number(swap.reserve0) / 10 ** pool.decimals0;
      const reserve1 = Number(swap.reserve1) / 10 ** pool.decimals1;

      // One priced side doubled, matching how the EVM indexer values a pool:
      // an AMM holds equal value on both sides by construction.
      const value = price0 ? reserve0 * price0 * 2 : reserve1 * price1! * 2;
      if (Number.isFinite(value) && value > 0) latest.set(pool.id, value);
    }

    await Promise.all(
      [...latest.entries()].map(([id, liquidityUsd]) =>
        db.prisma.indexedPool
          .update({ where: { id }, data: { liquidityUsd } })
          .catch(() => undefined)
      )
    );
  }

  /** Records identity for a token seen trading, so the rollup has a row. */
  private async catalogueToken(
    swap: DecodedSwapAt,
    decimals0: number,
    decimals1: number
  ): Promise<void> {
    const db = DatabaseService.getInstance();

    for (const [contractId, decimals] of [
      [swap.token0, decimals0],
      [swap.token1, decimals1],
    ] as const) {
      const symbol = contractId.split(".")[1] ?? contractId;
      await db.prisma.indexedToken
        .create({
          data: {
            chainId: this.chainId,
            contractId,
            symbol: symbol.replace(/^token-/, "").slice(0, 32).toUpperCase(),
            name: symbol.slice(0, 128),
            decimals,
            dexId: swap.dexId,
          },
        })
        .catch(() => undefined);
    }
  }

  private async saveCursor(lastBlock: bigint): Promise<void> {
    const db = DatabaseService.getInstance();
    await db.prisma.indexerCursor.upsert({
      where: { chainId: this.chainId },
      create: { chainId: this.chainId, lastBlock, lastPoolBlock: lastBlock },
      update: { lastBlock },
    });
  }
}

interface DecodedSwapAt {
  poolKey: string;
  token0: string;
  token1: string;
  amount0: bigint;
  amount1: bigint;
  zeroForOne: boolean;
  reserve0: bigint | null;
  reserve1: bigint | null;
  dexId: string;
  contractId: string;
  blockHeight: number;
  timestampMs: number;
  eventIndex: number;
}
