import { assertIngestionLease } from "../ingestionLease.js";
import { cvToString, deserializeCV } from "@stacks/transactions";
import { DatabaseService } from "../../db.js";
import { ConfigManager } from "../../../config.js";
import { logger } from "../../../utils/logger.js";
import { persistSwaps, type RawSwap } from "../swapStore.js";
import { bucketStartOf } from "../types.js";
import { decodeStacksSwapPrint, canDecodeStacksDex } from "./printDecoder.js";
import type { BackfillRun, ChainIndexer, IndexRunResult } from "../types.js";
import { backfillCutoffMs, backfillEnabled, type IndexerSettings } from "../settings.js";
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

/**
 * Transactions per `/extended/v1/tx/multiple` request. The endpoint takes a
 * repeated query parameter, so this is bounded by URL length rather than by
 * anything the API documents.
 */
const TX_BATCH_SIZE = 50;

interface StacksTx {
  tx_id: string;
  tx_status: string;
  block_height: number;
  block_time: number;
}

interface StacksEvent {
  event_type: string;
  event_index?: number;
  contract_log?: { contract_id?: string; value?: { repr?: string } };
}

/** One page of an address's transaction list. */
interface TxPage {
  results?: { tx?: StacksTx }[];
  /** List length. Absent on older API versions, in which case drift is not corrected. */
  total?: number;
}

/**
 * Where the downward walk has got to in one contract's transaction list.
 *
 * A *type alias* rather than an interface so it satisfies Prisma's
 * `InputJsonValue`, which an interface cannot because it has no implicit index
 * signature.
 *
 * `total` is not informational — it is the drift anchor. The API pages an
 * address by offset from the newest transaction, so every transaction that
 * arrives at the head shifts a stored offset down by one. Recording the list
 * length alongside the offset makes the correction exact: the same logical
 * position is later at `offset + (totalNow - total)`. Without it, a busy
 * contract's walk would slip backwards by however many trades happened between
 * ticks and could stall entirely.
 */
type ContractBackfill = {
  offset: number;
  total: number;
  done: boolean;
};

type StacksBackfillState = Record<string, ContractBackfill>;

/** Transactions per page when walking history. Matches the forward pass. */
const BACKFILL_PAGE_SIZE = 50;

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
    const state = (cursor.forwardState ?? {}) as Record<string, {
      lastBlock: number; offset: number; total: number; target: number;
    }>;
    let poolsDiscovered = 0;
    let swapsIngested = 0;
    let bucketsWritten = 0;
    const errors: unknown[] = [];
    for (const contract of this.stacks.swapContracts) {
      const entry = state[contract.contractId] ?? {
        lastBlock: Number(fromBlock), offset: 0, total: 0, target: tip,
      };
      try {
        const page = await this.forwardPage(contract, entry, tip);
        // Store before checkpointing. Retrying a page after a crash is idempotent.
        if (page.swaps.length) {
          const result = await this.ingest(page.swaps, fromBlock);
          poolsDiscovered += result.poolsDiscovered;
          bucketsWritten += result.bucketsWritten;
          swapsIngested += page.swaps.length;
        }
        state[contract.contractId] = page.next;
        await db.prisma.indexerCursor.update({
          where: { chainId: this.chainId }, data: { forwardState: state },
        });
      } catch (error) { errors.push(error); }
    }
    const committed = BigInt(Math.min(...this.stacks.swapContracts.map(
      (c) => state[c.contractId]?.lastBlock ?? Number(fromBlock)
    )));
    await this.saveCursor({ lastBlock: committed });
    if (errors.length) throw new AggregateError(errors, "Stacks sources incomplete; checkpoints retained");
    const backfilled = await this.backfillStep();
    return this.merge({ chainId: this.chainId, poolsDiscovered, swapsIngested,
      bucketsWritten, fromBlock, toBlock: committed, targetBlock: BigInt(tip) }, backfilled);
  }

  private async forwardPage(
    contract: StacksSwapContract,
    entry: { lastBlock: number; offset: number; total: number; target: number },
    tip: number
  ) {
    const path = `/extended/v2/addresses/${contract.contractId}/transactions`;
    const probe = await this.fetchJson<TxPage>(`${path}?limit=1&offset=0`);
    if (typeof probe.total !== "number") throw new Error("Stacks pagination requires total");
    const total = probe.total;
    const target = entry.offset > 0 ? entry.target : tip;
    let offset = entry.offset > 0 ? entry.offset + Math.max(0, total - entry.total) : 0;
    const pending: StacksTx[] = [];
    let complete = false;
    let inspected = 0;
    while (inspected < this.settings.maxTxPerRun && !complete) {
      const limit = Math.min(50, this.settings.maxTxPerRun - inspected);
      const page = await this.fetchJson<TxPage>(`${path}?limit=${limit}&offset=${offset}`);
      // A shifting offset is unsafe. Restart from the head on the next tick.
      if (page.total !== total) throw new Error("Stacks transaction list changed during scan");
      if (!Array.isArray(page.results)) throw new Error("Missing Stacks transaction page");
      for (const row of page.results) {
        const tx = row.tx ?? row as unknown as StacksTx;
        if (!tx.tx_id || !Number.isInteger(tx.block_height)) throw new Error("Invalid Stacks transaction");
        offset++; inspected++;
        if (tx.block_height <= entry.lastBlock) { complete = true; break; }
        if (tx.block_height <= target && tx.tx_status === "success") pending.push(tx);
      }
      if (page.results.length < limit) complete = true;
    }
    const swaps = await this.swapsInTxs(pending, contract);
    swaps.sort((a, b) => a.blockHeight - b.blockHeight || a.eventIndex - b.eventIndex);
    return { swaps, next: complete
      ? { lastBlock: target, offset: 0, total, target }
      : { lastBlock: entry.lastBlock, offset, total, target } };
  }

  /** Folds a backfill pass's counts into the run result the forward pass built. */
  private merge(result: IndexRunResult, backfilled: BackfillRun): IndexRunResult {
    return {
      ...result,
      poolsDiscovered: result.poolsDiscovered + backfilled.poolsDiscovered,
      swapsIngested: result.swapsIngested + backfilled.swapsIngested,
      bucketsWritten: result.bucketsWritten + backfilled.bucketsWritten,
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
    const info = await this.fetchJson<{ stacks_tip_height?: number; chain_tip?: { block_height?: number } }>("/extended/v1/status");
    const height = info.stacks_tip_height ?? info.chain_tip?.block_height;
    if (typeof height !== "number" || isNaN(height)) {
      throw new Error(`Invalid or missing tip height from Stacks API: ${JSON.stringify(info)}`);
    }
    return height;
  }

  /**
   * The swap prints inside a batch of transactions.
   *
   * The transaction list returns an empty `events` array, so the payloads have
   * to be fetched separately — but `/extended/v1/tx/multiple` takes many ids at
   * once, which is the difference between one request per swap and one per
   * fifty. The first version did the former, and against a busy contract that
   * is hundreds of round trips a tick against an API that rate-limits hard.
   */
  private async swapsInTxs(
    txs: StacksTx[],
    contract: StacksSwapContract
  ): Promise<DecodedSwapAt[]> {
    const out: DecodedSwapAt[] = [];

    for (let i = 0; i < txs.length; i += TX_BATCH_SIZE) {
      const batch = txs.slice(i, i + TX_BATCH_SIZE);
      const query = batch.map((tx) => `tx_id=${tx.tx_id}`).join("&");

      const detail = await this.fetchJson<
        Record<string, { found?: boolean; result?: { events?: StacksEvent[]; event_count?: number } }>
      >(`/extended/v1/tx/multiple?${query}&event_limit=100`);

      for (const tx of batch) {
        const result = detail[tx.tx_id]?.result;
        if (!result || !Array.isArray(result.events)) throw new Error(`Missing Stacks transaction ${tx.tx_id}`);
        const events = [...result.events];
        // Fetch every event, including transactions with more than 100 prints.
        const count = result.event_count ?? events.length;
        if (result.event_count == null && events.length === 100) {
          throw new Error(`Unknown event count for full page: ${tx.tx_id}`);
        }
        while (events.length < count) {
          const page = await this.fetchJson<{ events?: StacksEvent[] }>(
            `/extended/v1/tx/${tx.tx_id}?event_limit=100&event_offset=${events.length}`
          );
          if (!page.events?.length) throw new Error(`Incomplete events: ${tx.tx_id}`);
          events.push(...page.events);
        }

        for (const [index, event] of events.entries()) {
          if (event.event_type !== "smart_contract_log") continue;
          if (event.contract_log?.contract_id !== contract.contractId) continue;

          const decoded = decodeStacksSwapPrint(
            event.contract_log?.value?.repr ?? "",
            contract.dexId
          );
          if (!decoded) continue;

          out.push({
            ...decoded,
            dexId: contract.dexId,
            contractId: contract.contractId,
            txId: tx.tx_id,
            blockHeight: tx.block_height,
            // Stacks reports seconds; bucket boundaries are milliseconds.
            timestampMs: tx.block_time * 1000,
            eventIndex: event.event_index ?? index,
          });
        }
      }
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
    const { rawSwaps, poolState } = this.valueSwaps(swaps, pools, usd);

    const bucketsWritten = await persistSwaps(rawSwaps);

    await assertIngestionLease();
    await db.prisma.$transaction([
      ...[...poolState.entries()].map(([poolId, state]) =>
        db.prisma.indexedPool.updateMany({
          where: { id: poolId, OR: [{ lastSwapAt: null }, { lastSwapAt: { lte: state.at } }] },
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

    return { bucketsWritten, poolsDiscovered: discovered };
  }

  /**
   * Prices decoded swaps and shapes them for storage.
   *
   * Shared by the forward pass and the history walk; what the two do with
   * `poolState` is where they differ. See `ingestHistory`.
   */
  private valueSwaps(
    swaps: DecodedSwapAt[],
    pools: Map<string, StacksPool>,
    usd: Map<string, number>
  ): { rawSwaps: RawSwap[]; poolState: Map<number, { price: number; at: Date }> } {
    const rawSwaps: RawSwap[] = [];
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
      rawSwaps.push({
        poolId: pool.id,
        // Identity on chain: the same print re-read produces the same key, so
        // a replayed range inserts nothing.
        txKey: `${swap.txId}:${swap.eventIndex}`,
        blockNumber: BigInt(swap.blockHeight),
        logIndex: swap.eventIndex,
        bucketStart: bucketStartOf(swap.timestampMs),
        priceUsd,
        volumeUsd,
        isBuy: !swap.zeroForOne,
      });

      if (priceUsd > 0) poolState.set(pool.id, { price: priceUsd, at });
    }

    return { rawSwaps, poolState };
  }

  // ─── Backfill ──────────────────────────────────────────────────────────────

  /**
   * Walks each swap contract's transaction list downward, into history.
   *
   * The EVM indexer backfills by asking for an earlier block range. Nothing
   * here can: the Stacks API pages an address's transactions by offset from the
   * newest, with no way to address a height, so "walk backwards" means "keep
   * paging and remember where you stopped". That per-contract offset is what
   * `IndexerCursor.backfillState` holds, and why this family needed a cursor
   * shape of its own rather than a second bigint.
   *
   * Bounded twice over: `maxBackfillSourcesPerRun` contracts per tick, and
   * `maxTxPerRun` transactions within each. Neither the walk nor the forward
   * pass can starve the other.
   */
  private async backfillStep(): Promise<BackfillRun> {
    const none: BackfillRun = { swapsIngested: 0, bucketsWritten: 0, poolsDiscovered: 0 };
    if (!backfillEnabled(this.settings)) return none;

    const db = DatabaseService.getInstance();
    const cursor = await db.prisma.indexerCursor.findUnique({
      where: { chainId: this.chainId },
    });
    if (!cursor || cursor.backfillDone) return none;

    const state = readBackfillState(cursor.backfillState);
    const cutoffMs = backfillCutoffMs(this.settings);

    const pending = this.stacks.swapContracts
      .filter((contract) => !state[contract.contractId]?.done)
      .slice(0, this.settings.maxBackfillSourcesPerRun);

    if (pending.length === 0) {
      await this.saveCursor({ backfillDone: true });
      logger.info("[indexer] backfill complete", { chainId: this.chainId });
      return none;
    }

    const collected: DecodedSwapAt[] = [];
    let lowestBlock: number | null = null;

    for (const contract of pending) {
      const entry = state[contract.contractId] ?? { offset: 0, total: 0, done: false };

      try {
        const walked = await this.backfillContract(contract, entry, cutoffMs);
        collected.push(...walked.swaps);
        state[contract.contractId] = walked.next;
        if (walked.lowestBlock !== null) {
          lowestBlock =
            lowestBlock === null ? walked.lowestBlock : Math.min(lowestBlock, walked.lowestBlock);
        }
      } catch (error) {
        // One contract's history failing must not cost the others theirs. The
        // entry keeps its old offset, so the same page is retried next tick.
        logger.warn("[indexer] stacks backfill read failed", {
          chainId: this.chainId,
          contract: contract.contractId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const ingested =
      collected.length > 0
        ? await this.ingestHistory(collected)
        : { swapsIngested: 0, bucketsWritten: 0, poolsDiscovered: 0 };

    const allDone = this.stacks.swapContracts.every((c) => state[c.contractId]?.done);

    await this.saveCursor({
      backfillState: state,
      backfillDone: allDone,
      // Purely observability: how deep the walk has reached. Nothing resumes
      // from it, since the resume point is an offset rather than a height.
      ...(lowestBlock !== null ? { backfillBlock: BigInt(lowestBlock) } : {}),
    });

    if (allDone) logger.info("[indexer] backfill complete", { chainId: this.chainId });
    else if (ingested.swapsIngested > 0) {
      logger.info("[indexer] backfilled", {
        chainId: this.chainId,
        swaps: ingested.swapsIngested,
        lowestBlock,
      });
    }

    return ingested;
  }

  /**
   * One contract's page walk for this tick.
   *
   * Stops on any of: the transaction budget, a transaction older than the
   * window, or the end of the list. The first is a pause and the other two are
   * terminal.
   */
  private async backfillContract(
    contract: StacksSwapContract,
    entry: ContractBackfill,
    cutoffMs: number | null
  ): Promise<{ swaps: DecodedSwapAt[]; next: ContractBackfill; lowestBlock: number | null }> {
    const path = `/extended/v2/addresses/${contract.contractId}/transactions`;

    // A one-row probe, purely to read the list length before committing to a
    // page. Correcting the offset afterwards would mean fetching a page from
    // the wrong position first — fifty transaction bodies for nothing.
    const probe = await this.fetchJson<TxPage>(`${path}?limit=1&offset=0`);
    const total = typeof probe.total === "number" ? probe.total : 0;

    // Everything new arrives at the head, so it shifts a stored position down
    // by exactly however much arrived.
    let offset =
      entry.total > 0 && total > entry.total ? entry.offset + (total - entry.total) : entry.offset;

    const pending: StacksTx[] = [];
    let inspected = 0;
    let done = false;
    let lowestBlock: number | null = null;

    while (inspected < this.settings.maxTxPerRun && !done) {
      const page = await this.fetchJson<TxPage>(
        `${path}?limit=${BACKFILL_PAGE_SIZE}&offset=${offset}`
      );
      const rows = page.results ?? [];

      // Walked off the end of the list: there is no more history to have.
      if (rows.length === 0) {
        done = true;
        break;
      }

      for (const row of rows) {
        const tx = row.tx ?? (row as unknown as StacksTx);
        if (!tx?.tx_id) continue;

        offset++;
        inspected++;

        // The list is newest-first, so the first transaction below the cutoff
        // means every one after it is older still.
        if (cutoffMs !== null && tx.block_time * 1000 < cutoffMs) {
          done = true;
          break;
        }

        if (tx.tx_status !== "success") continue;

        pending.push(tx);
        lowestBlock =
          lowestBlock === null ? tx.block_height : Math.min(lowestBlock, tx.block_height);
      }

      if (rows.length < BACKFILL_PAGE_SIZE) done = true;
    }

    const swaps = pending.length > 0 ? await this.swapsInTxs(pending, contract) : [];

    return { swaps, next: { offset, total, done }, lowestBlock };
  }

  /**
   * Stores historical swaps, and touches nothing that means *latest*.
   *
   * `lastPrice0`, `lastSwapAt` and pool liquidity are all statements about the
   * present. Writing them from a walk through last week's trades moves a pool's
   * current price backwards in time — and since the deepest pool sets a token's
   * displayed price, that surfaces as the quoted price jumping to a stale one.
   * The EVM walk skips them for the same reason.
   */
  private async ingestHistory(swaps: DecodedSwapAt[]): Promise<BackfillRun> {
    const { pools, discovered } = await this.resolvePools(swaps);
    const usd = await this.usdPrices(pools, swaps);
    const { rawSwaps } = this.valueSwaps(swaps, pools, usd);

    const bucketsWritten = await persistSwaps(rawSwaps);

    return { swapsIngested: rawSwaps.length, bucketsWritten, poolsDiscovered: discovered };
  }

  /** `contract#poolKey` — unique per pool and stable across restarts. */
  private poolAddressOf(swap: DecodedSwapAt): string {
    return swap.dexId === "bitflow" && swap.poolKey.includes(".") ? swap.poolKey : `${swap.contractId}#${swap.poolKey}`;
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
      const match = body.result && body.okay ? cvToString(deserializeCV(body.result)).match(/^\(ok u(\d+)\)$/) : null;
      const decimals = match ? Number(match[1]) : NaN;

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
      if (!pool) continue;
      let raw0 = swap.reserve0, raw1 = swap.reserve1;
      if ((raw0 === null || raw1 === null) && swap.dexId === "bitflow" && swap.poolKey.includes(".")) {
        const [address, name] = swap.poolKey.split(".");
        const response = await fetch(`${this.api}/v2/contracts/call-read/${address}/${name}/get-pool`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender: address, arguments: [] }),
        });
        if (!response.ok) throw new Error("Bitflow pool state unavailable");
        const body = await response.json() as { okay?: boolean; result?: string };
        if (!body.okay || !body.result) throw new Error("Invalid Bitflow pool state");
        const repr = cvToString(deserializeCV(body.result));
        const x = repr.match(/\(x-balance u(\d+)\)/)?.[1];
        const y = repr.match(/\(y-balance u(\d+)\)/)?.[1];
        if (x == null || y == null) throw new Error("Bitflow reserves missing");
        raw0 = BigInt(x); raw1 = BigInt(y);
      }
      if (raw0 === null || raw1 === null) continue;

      const price0 = usd.get(pool.token0);
      const price1 = usd.get(pool.token1);
      if (!price0 && !price1) continue;

      const reserve0 = Number(raw0) / 10 ** pool.decimals0;
      const reserve1 = Number(raw1) / 10 ** pool.decimals1;

      // One priced side doubled, matching how the EVM indexer values a pool:
      // an AMM holds equal value on both sides by construction.
      const ratio = (Number(swap.amount1) / 10 ** pool.decimals1) / (Number(swap.amount0) / 10 ** pool.decimals0);
      const usd0 = price0 ?? ratio * price1!;
      const usd1 = price1 ?? price0! / ratio;
      const value = reserve0 * usd0 + reserve1 * usd1;
      if (Number.isFinite(value) && value >= 0) latest.set(pool.id, value);
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

  private async saveCursor(data: {
    lastBlock?: bigint;
    backfillBlock?: bigint;
    backfillState?: StacksBackfillState;
    backfillDone?: boolean;
  }): Promise<void> {
    const db = DatabaseService.getInstance();
    await assertIngestionLease();
    await db.prisma.indexerCursor.upsert({
      where: { chainId: this.chainId },
      create: {
        chainId: this.chainId,
        lastBlock: data.lastBlock ?? 0n,
        lastPoolBlock: data.lastBlock ?? 0n,
      },
      update: data,
    });
  }
}

/**
 * Reads the stored paging state, treating anything unrecognised as empty.
 *
 * A Json column has no schema, so this is where one is imposed. An entry that
 * doesn't parse restarts that contract's walk from the head rather than
 * throwing: re-reading history is a no-op now that swaps are stored under their
 * on-chain identity, so the failure mode is wasted requests rather than
 * inflated volume.
 */
function readBackfillState(value: unknown): StacksBackfillState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const out: StacksBackfillState = {};
  for (const [contractId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { offset, total, done } = entry as Partial<ContractBackfill>;
    if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) continue;

    out[contractId] = {
      offset,
      total: typeof total === "number" && total >= 0 ? total : 0,
      done: done === true,
    };
  }
  return out;
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
  txId: string;
  blockHeight: number;
  timestampMs: number;
  eventIndex: number;
}
