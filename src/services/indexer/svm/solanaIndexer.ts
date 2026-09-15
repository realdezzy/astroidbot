import bs58 from "bs58";
import { decodePumpTrades, PUMP_PROGRAM } from "./pumpCurve.js";
import { assertIngestionLease } from "../ingestionLease.js";
import { discoverSolanaPrograms } from "./discoverPrograms.js";
import { decodeInstructionSwaps, type ParsedSwapTransaction } from "./instructionSwaps.js";
import { DatabaseService } from "../../db.js";
import { logger } from "../../../utils/logger.js";
import { persistSwaps, type RawSwap } from "../swapStore.js";
import { bucketStartOf } from "../types.js";
import {
  decodeSolanaSwap,
  type SolanaTransactionMeta,
} from "./balanceDeltas.js";
import type { BackfillRun, ChainIndexer, IndexRunResult } from "../types.js";
import { backfillCutoffMs, backfillEnabled, type IndexerSettings } from "../settings.js";
import { resolveNativeUsd } from "../nativePricing.js";
import type { ChainDescriptor, ChainId } from "../../../types/chain.js";
import { requireSvmConfig } from "../../../types/chain.js";
import { rpcUrlOverride } from "../../chains/evm/evmClient.js";

/**
 * Swap ingestion for Solana.
 *
 * The two hard parts are solved differently from every other family:
 *
 * **Discovery.** Solana has no pool factory to enumerate. `getProgramAccounts`
 * over Raydium or Orca returns hundreds of thousands of accounts with no
 * pagination, which is not a thing a poll can do. So pools are discovered from
 * *the router we already depend on*: a Jupiter quote's `routePlan` names the
 * `ammKey` of every pool it would route through. That scopes discovery to
 * pairs the product can actually trade, which is the same set the discovery
 * pages care about, and it costs one quote per pair rather than a full program
 * scan.
 *
 * **Decoding.** Every AMM encodes its swap instruction differently, and there
 * are dozens. Rather than a decoder per program, amounts come from the
 * transaction's own `preTokenBalances`/`postTokenBalances` — the runtime
 * reports, for every token account the transaction touched, the balance before
 * and after. Diffing the pool's two vaults gives exact in/out amounts for any
 * AMM that has ever existed or will. See balanceDeltas.ts.
 *
 * **The cursor is a signature, not a slot.** `getSignaturesForAddress` pages
 * backwards from newest and takes an `until` signature; there is no "give me
 * this slot range" for an account. Slot is still recorded, because it is what
 * `lastBlock` means everywhere else and what the backfill and health surfaces
 * read.
 */

interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

interface SolanaPool {
  id: number;
  poolAddress: string;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  /**
   * Where this pool's forward pass got to.
   *
   * Carried on the shape rather than re-read per pool: `trackedPools()` selects
   * the whole row and used to project this away, only for `ingestPool` to
   * issue a `findUnique` to fetch it back — one round trip per tracked pool,
   * per tick, for a column already in hand.
   */
  lastSignature: string | null;
  forwardBefore?: string | null;
  forwardHead?: string | null;
  forwardTargetBlock?: bigint | null;
  lastSwapAt?: Date | null;
  lastPrice0?: number | null;
  programId?: string | null;
  vault0?: string | null;
  vault1?: string | null;
  baseToken?: string | null;
}

/**
 * Signatures per `getSignaturesForAddress` call. The RPC caps this at 1000, and
 * listing is cheap — it is fetching each transaction's body that costs.
 */


/**
 * Pages the forward pass will walk to reach its `until` mark.
 *
 * A pool that has produced more than a million signatures since the last tick
 * is not one this indexer can catch up on within a tick anyway, and the bound
 * stops a misconfigured cursor from paging an account's entire history.
 */


/**
 * Wrapped SOL.
 *
 * Hardcoded as a last-resort anchor because it is the one mint on this chain
 * that genuinely cannot change, and because resolving it through the DEX
 * provider fails exactly when the provider is unreachable — which is when an
 * anchor matters most.
 */
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

/** What one pool's forward pass learned, written back after the batch. */
interface PoolProgress {
  /** Newest signature *read* this pass, decodable or not. */
  signature: string;
  forwardBefore?: string | null;
  forwardHead?: string | null;
  targetBlock?: bigint;
  /** Newest price decoded, or null if nothing in the batch priced. */
  price: number | null;
  at: Date | null;
  /** Where the downward walk starts. Set only on a pool's first pass. */
  backfillSeed?: string;
}

export class SolanaIndexer implements ChainIndexer {
  readonly chainId: ChainId;
  private readonly svm;

  /** Swappable-token list, memoised for the duration of one tick. */
  private tokenList: Promise<{ symbol: string; contractId: string }[]> | null = null;
  /** symbol (upper) -> mint, or null for "asked and not listed". Per tick. */
  private mintCache = new Map<string, string | null>();

  constructor(
    private readonly descriptor: ChainDescriptor,
    private readonly settings: IndexerSettings
  ) {
    this.chainId = descriptor.chainId;
    this.svm = requireSvmConfig(descriptor);
  }

  /**
   * Indexable when the chain can be quoted, because that is where pools come
   * from. Solana devnet has no Jupiter deployment and so has no pools to find
   * — being un-indexable there is correct, not a misconfiguration.
   */
  static canIndex(descriptor: ChainDescriptor): boolean {
    return descriptor.family === "svm" && Boolean(descriptor.svm?.jupiterApiUrl);
  }

  private get rpcUrl(): string {
    return rpcUrlOverride(this.chainId, this.svm.defaultRpcUrl);
  }

  /**
   * Several RPC calls in one HTTP round trip.
   *
   * `getTransaction` is per signature, so a pool with fifty new swaps meant
   * fifty requests — which is how the first version of this indexer would have
   * exhausted a public endpoint's rate limit within a tick. JSON-RPC batching
   * keeps the same targeted queries and collapses the round trips.
   *
   * Block-based ingestion is the usual alternative and is the wrong trade here:
   * following a few hundred named pools, `getSignaturesForAddress` asks for
   * exactly what we want, while scanning blocks would pull every transaction on
   * Solana and filter client-side.
   */
  private async rpcBatch<T>(calls: { method: string; params: unknown[] }[]): Promise<(T | null)[]> {
    if (calls.length === 0) return [];

    const body = await this.post<{ id: number; result?: T; error?: unknown }[]>(
      calls.map((call, id) => ({ jsonrpc: "2.0", id, method: call.method, params: call.params })),
      "batch"
    );

    // Responses may come back in any order, so they are placed by id rather
    // than assumed to line up with the request array.
    const out: (T | null)[] = new Array(calls.length).fill(null);
    for (const entry of Array.isArray(body) ? body : []) {
      if (entry.error || entry.result === undefined) continue;
      out[entry.id] = entry.result as T;
    }
    return out;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const body = await this.post<{ result?: T; error?: { message?: string } }>(
      { jsonrpc: "2.0", id: 1, method, params },
      method
    );

    if (body.error) throw new Error(`Solana RPC ${method}: ${body.error.message ?? "error"}`);
    return body.result as T;
  }

  /**
   * One JSON-RPC POST, retried when the endpoint says to slow down.
   *
   * Every Solana call in this class goes through here, and the retry is why:
   * a throttled response used to throw, be caught at the pool level, and be
   * logged at `debug` — so a rate-limited endpoint looked exactly like a set of
   * pools that had stopped trading. Measured against a metered provider at the
   * concurrency this indexer actually uses, half the requests came back 429.
   *
   * `Retry-After` is honoured when the endpoint sends one; otherwise the wait
   * doubles from the configured backoff. Bounded attempts, because a tick that
   * spends its whole budget retrying one pool has starved the rest.
   */
  private async post<T>(payload: unknown, label: string): Promise<T> {
    const RETRIES = 3;
    let wait = this.settings.retryBackoffMs;

    for (let attempt = 0; ; attempt++) {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) return (await response.json()) as T;

      const throttled = response.status === 429 || response.status === 503;
      if (!throttled || attempt >= RETRIES) {
        throw new Error(`Solana RPC ${response.status} for ${label}`);
      }

      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait;

      logger.debug("[indexer] solana rpc throttled, backing off", {
        chainId: this.chainId,
        label,
        status: response.status,
        delayMs: delay,
        attempt: attempt + 1,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
      wait *= 2;
    }
  }

  async run(): Promise<IndexRunResult> {
    this.resetTickCaches();

    const db = DatabaseService.getInstance();
    const slot = await this.rpc<number>("getSlot", [{ commitment: "finalized" }]);

    const cursor = await db.prisma.indexerCursor.findUnique({
      where: { chainId: this.chainId },
    });

    if (!cursor) {
      await db.prisma.indexerCursor.create({
        data: {
          chainId: this.chainId,
          lastBlock: 0n,
          lastPoolBlock: BigInt(slot),
          backfillBlock: BigInt(slot),
        },
      });
    }

    const poolsDiscovered = await this.discoverPools();
    const pools = await this.trackedPools();

    if (pools.length === 0) {
      await this.saveCursor(BigInt(slot));
      return this.result(poolsDiscovered, 0, 0, cursor?.lastBlock ?? BigInt(slot), BigInt(slot));
    }

    const { swapsIngested, bucketsWritten } = await this.ingest(pools, BigInt(slot));

    // History is walked only after the live pass has been served: the forward
    // pass is what the product is for, and a chain catching up must not spend
    // its request budget walking backwards.
    const backfilled = await this.backfillStep();

    const committed = await db.prisma.indexerCursor.findUnique({ where: { chainId: this.chainId } });
    return { ...this.result(
      poolsDiscovered,
      swapsIngested + backfilled.swapsIngested,
      bucketsWritten + backfilled.bucketsWritten,
      cursor?.lastBlock ?? BigInt(slot),
      committed?.lastBlock ?? 0n
    ), targetBlock: BigInt(slot), sourcesProcessed: pools.length };
  }

  private result(
    poolsDiscovered: number,
    swapsIngested: number,
    bucketsWritten: number,
    fromBlock: bigint,
    toBlock: bigint
  ): IndexRunResult {
    return { chainId: this.chainId, poolsDiscovered, swapsIngested, bucketsWritten, fromBlock, toBlock };
  }

  /**
   * Asks the router which pools serve the pairs we list, and records them.
   *
   * Runs every tick and is nearly free after the first: pools already known are
   * skipped before any write, and the quote itself is a single request per
   * pair. New pools appear when liquidity moves to them, which is exactly when
   * we want to start following them.
   */
  private async discoverPools(): Promise<number> {
    const quoteMints = new Set([WRAPPED_SOL_MINT]);
    const stable = await this.mintFor(this.descriptor.stableSymbol);
    if (stable) quoteMints.add(stable);
    return discoverSolanaPrograms(this.chainId, (method, params) => this.rpc(method, params), quoteMints);
  }

  /**
   * Resolves a symbol to its mint through the chain's DEX provider list.
   *
   * The list is fetched once per tick rather than once per lookup. Each call
   * pulled the provider's entire swappable set to answer one symbol, and a tick
   * asks at least five times — the stable and native mints during discovery,
   * again while building the USD anchors, and again on the backfill pass.
   */
  private async mintFor(symbol: string): Promise<string | null> {
    const key = symbol.toUpperCase();

    const cached = this.mintCache.get(key);
    if (cached !== undefined) return cached;

    if (!this.tokenList) {
      const { DEXRegistry } = await import("../../dex/dexRegistry.js");
      this.tokenList = DEXRegistry.getInstance()
        .getSwappableTokens(false, this.chainId)
        .catch(() => []);
    }

    const tokens = await this.tokenList;
    const mint = tokens.find((t) => t.symbol.toUpperCase() === key)?.contractId ?? null;

    this.mintCache.set(key, mint);
    return mint;
  }

  /**
   * Drops the per-tick memoisation.
   *
   * Held for a tick and no longer: a token listed between ticks should be
   * visible on the next one, and a provider that was unreachable must get
   * another chance rather than having its empty list cached for the life of
   * the process.
   */
  private resetTickCaches(): void {
    this.tokenList = null;
    this.mintCache.clear();
  }

  private async trackedPools(): Promise<SolanaPool[]> {
    const rows = await DatabaseService.getInstance().prisma.indexedPool.findMany({
      where: { chainId: this.chainId, programId: { not: null }, vault0: { not: null }, vault1: { not: null } },
      orderBy: [{ lastPolledAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
      take: this.settings.maxPools,
    });

    return rows.map((r) => ({
      id: r.id,
      poolAddress: r.poolAddress,
      token0: r.token0,
      token1: r.token1,
      decimals0: r.decimals0,
      decimals1: r.decimals1,
      lastSignature: r.lastSignature,
      forwardBefore: r.forwardBefore,
      forwardHead: r.forwardHead,
      forwardTargetBlock: r.forwardTargetBlock,
      lastSwapAt: r.lastSwapAt,
      lastPrice0: r.lastPrice0,
      programId: r.programId, vault0: r.vault0, vault1: r.vault1, baseToken: r.baseToken,
    }));
  }

  /**
   * Reads new signatures per pool and folds their swaps into candles.
   *
   * Per-pool cursors live in `IndexedPool.lastSignature` because
   * `getSignaturesForAddress` is per account and pages backwards: a shared
   * chain-wide cursor could not express "pool A is caught up, pool B is not".
   */
  private async ingest(
    pools: SolanaPool[],
    slot: bigint
  ): Promise<{ swapsIngested: number; bucketsWritten: number }> {
    const db = DatabaseService.getInstance();
    const usd = await this.usdPrices(pools);

    const rawSwaps: RawSwap[] = [];
    const poolState = new Map<number, PoolProgress>();
    let swapsIngested = 0;
    const errors: unknown[] = [];

    for (const pool of pools) {
      try {
        const result = await this.ingestPool(pool, usd, rawSwaps, slot);
        swapsIngested += result.swaps;
        if (result.progress) {
          poolState.set(pool.id, result.progress);
        }
      } catch (error) {
        errors.push(error);
        logger.warn("[indexer] solana pool ingest failed", {
          chainId: this.chainId,
          pool: pool.poolAddress,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const bucketsWritten = await persistSwaps(rawSwaps);
    await this.refreshLiquidity(pools, usd, poolState);

    await assertIngestionLease();
    await db.prisma.$transaction([
      ...[...poolState.entries()].map(([poolId, state]) =>
        db.prisma.indexedPool.update({
          where: { id: poolId },
          data: {
            lastSignature: state.signature,
            forwardBefore: state.forwardBefore ?? null,
            forwardHead: state.forwardHead ?? null,
            forwardTargetBlock: state.forwardBefore ? state.targetBlock : null,
            ...(!state.forwardBefore && state.targetBlock != null ? { lastIndexedBlock: state.targetBlock } : {}),
            // Only when something actually decoded. A tick that processed
            // signatures without finding a priceable swap still advances the
            // cursor — it has genuinely read them — but it has learned nothing
            // about the pool's price, and writing a zero here would erase one.
            ...(state.price !== null ? { lastPrice0: state.price, lastSwapAt: state.at } : {}),
            // Seeded once, on the pass that had no cursor to resume from:
            // that pass reads the newest page, so its oldest signature is
            // exactly where a downward walk has to start. Later passes leave
            // it alone.
            ...(state.backfillSeed ? { backfillSignature: state.backfillSeed } : {}),
          },
        })
      ),
    ]);

    const where = { chainId: this.chainId, programId: { not: null } };
    const [oldest, unknown] = await Promise.all([
      db.prisma.indexedPool.aggregate({ where, _min: { lastIndexedBlock: true } }),
      db.prisma.indexedPool.count({ where: { ...where, lastIndexedBlock: null } }),
    ]);
    if (unknown === 0) await this.saveCursor(oldest._min.lastIndexedBlock ?? slot);
    if (errors.length) throw new AggregateError(errors, "Solana pools incomplete; checkpoints retained");
    return { swapsIngested, bucketsWritten };
  }

  private async refreshLiquidity(pools: SolanaPool[], usd: Map<string, number>, states: Map<number, PoolProgress>): Promise<void> {
    for (const pool of pools) {
      if (pool.programId === PUMP_PROGRAM) {
        const account = await this.rpc<{ value?: { data: [string, string] } }>("getAccountInfo", [pool.poolAddress, { encoding: "base64", commitment: "finalized" }]);
        if (!account.value) throw new Error("Pump curve state unavailable");
        const data = Buffer.from(account.value.data[0], "base64");
        if (data.length < 49) throw new Error("Invalid Pump curve state");
        const price0 = states.get(pool.id)?.price ?? pool.lastPrice0;
        const price1 = usd.get(pool.token1);
        if (price0 && price1) {
          const liquidityUsd = Number(data.readBigUInt64LE(24)) / 10 ** pool.decimals0 * price0 + Number(data.readBigUInt64LE(32)) / 10 ** pool.decimals1 * price1;
          await DatabaseService.getInstance().prisma.indexedPool.update({ where: { id: pool.id }, data: { liquidityUsd } });
        }
        continue;
      }
      if (!pool.vault0 || !pool.vault1) continue;
      const accounts = await this.rpc<{ value: ({ data?: { parsed?: { info?: { tokenAmount?: { amount: string } } } } } | null)[] }>("getMultipleAccounts", [[pool.vault0, pool.vault1], { encoding: "jsonParsed", commitment: "finalized" }]);
      const amounts = accounts.value?.map((a) => a?.data?.parsed?.info?.tokenAmount?.amount);
      if (amounts?.length !== 2 || amounts.some((a) => a == null)) throw new Error("Pool vault balances unavailable");
      const p0 = usd.get(pool.token0) ?? states.get(pool.id)?.price ?? pool.lastPrice0;
      const p1 = usd.get(pool.token1);
      if (!p0 || !p1) continue;
      const liquidityUsd = Number(amounts[0]) / 10 ** pool.decimals0 * p0 + Number(amounts[1]) / 10 ** pool.decimals1 * p1;
      if (!Number.isFinite(liquidityUsd) || liquidityUsd < 0) throw new Error("Invalid vault value");
      await DatabaseService.getInstance().prisma.indexedPool.update({ where: { id: pool.id }, data: { liquidityUsd } });
    }
  }

  private async ingestPool(
    pool: SolanaPool,
    usd: Map<string, number>,
    rawSwaps: RawSwap[],
    observedSlot?: bigint
  ): Promise<{ swaps: number; progress: PoolProgress | null }> {
    const limit = Math.min(1000, this.settings.maxTxPerRun);
    const signatures = await this.rpc<SignatureInfo[]>("getSignaturesForAddress", [pool.poolAddress, {
      limit, commitment: "finalized",
      ...(pool.lastSignature ? { until: pool.lastSignature } : {}),
      ...(pool.forwardBefore ? { before: pool.forwardBefore } : {}),
    }]);
    if (!Array.isArray(signatures)) throw new Error("Missing signature page");
    await DatabaseService.getInstance().prisma.indexedPool.update({ where: { id: pool.id }, data: { lastPolledAt: new Date() } });
    const head = pool.forwardHead ?? signatures[0]?.signature;
    if (!head) {
      if (observedSlot != null) await DatabaseService.getInstance().prisma.indexedPool.update({ where: { id: pool.id }, data: { lastIndexedBlock: observedSlot } });
      return { swaps: 0, progress: null };
    }
    const complete = !pool.lastSignature || signatures.length < limit;
    const decoded = await this.decodeBatch(pool, [...signatures].reverse().filter((s) => !s.err), usd, rawSwaps);
    // A backward page must never overwrite a newer observed price.
    const fresh = decoded.at != null && (!pool.lastSwapAt || decoded.at >= pool.lastSwapAt);
    return { swaps: decoded.swaps, progress: {
      signature: complete ? head : pool.lastSignature!,
      targetBlock: pool.forwardTargetBlock ?? observedSlot ?? BigInt(signatures[0]?.slot ?? 0),
      forwardBefore: complete ? null : signatures.at(-1)!.signature,
      forwardHead: complete ? null : head,
      price: fresh ? decoded.price : null, at: fresh ? decoded.at : null,
      backfillSeed: pool.lastSignature ? undefined : signatures.at(-1)?.signature,
    } };
  }

  /**
   * Fetches, decodes and prices a batch of signatures, oldest first.
   *
   * Returns the newest price it managed to decode, which is what the caller
   * writes back as the pool's current state — and nothing, rather than zero,
   * when none of them priced.
   */
  private async decodeBatch(
    pool: SolanaPool,
    batch: SignatureInfo[],
    usd: Map<string, number>,
    rawSwaps: RawSwap[]
  ): Promise<{ swaps: number; price: number | null; at: Date | null }> {
    const transactions = await this.rpcBatch<ParsedSwapTransaction & { meta?: SolanaTransactionMeta & { logMessages?: string[] }; blockTime?: number }>(
      batch.map((info) => ({
        method: "getTransaction",
        params: [info.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "finalized" }],
      }))
    );

    let swaps = 0;
    let price: number | null = null;
    let at: Date | null = null;

    for (const [index, info] of batch.entries()) {
      const tx = transactions[index];
      if (!tx?.meta) throw new Error(`Transaction unavailable: ${info.signature}; retaining cursor`);

      const pumpCpi = tx.meta.innerInstructions?.flatMap((group) => group.instructions).flatMap((ix) => {
        if (ix.programId !== PUMP_PROGRAM || !ix.data) return [];
        const bytes = Buffer.from(bs58.decode(ix.data));
        if (bytes.subarray(0, 8).toString("hex") !== "e445a52e51cb9a1d") return [];
        return [`Program ${PUMP_PROGRAM} invoke [1]`, `Program data: ${bytes.subarray(8).toString("base64")}`, `Program ${PUMP_PROGRAM} success`];
      }) ?? [];
      const decoded = pool.programId === PUMP_PROGRAM
        ? decodePumpTrades(pumpCpi.length ? pumpCpi : tx.meta.logMessages ?? [], pool.token0, pool.token1)
        : pool.programId && pool.vault0 && pool.vault1
        ? decodeInstructionSwaps(tx, { poolAddress: pool.poolAddress, programId: pool.programId, vault0: pool.vault0, vault1: pool.vault1 })
        : [];
      if (!pool.programId && decodeSolanaSwap(tx.meta, pool.poolAddress, pool.token0, pool.token1)) {
        throw new Error("Pool needs verified program and vault mapping before ingestion");
      }
      if (decoded.length === 0) continue;
      const block = await this.rpc<{ signatures?: string[] }>("getBlock", [info.slot, {
        commitment: "finalized", transactionDetails: "signatures", rewards: false,
      }]);
      const txIndex = block.signatures?.indexOf(info.signature) ?? -1;
      if (txIndex < 0) throw new Error("Missing transaction position in finalized block");
      for (const swap of decoded) {
        const amount0 = Number(swap.amount0) / 10 ** pool.decimals0;
        const amount1 = Number(swap.amount1) / 10 ** pool.decimals1;
        if (amount0 <= 0 || amount1 <= 0) throw new Error("Invalid swap amounts");
        const price0 = usd.get(pool.token0);
        const price1 = usd.get(pool.token1);
        const token0Usd = price1 ? amount1 / amount0 * price1 : price0 ?? 0;
        const token1Usd = price0 ? amount0 / amount1 * price0 : price1 ?? 0;
        const priceUsd = pool.baseToken === pool.token1 ? token1Usd : token0Usd;
        const volumeUsd = price1 ? amount1 * price1 : price0 ? amount0 * price0 : 0;
        const timestampMs = (info.blockTime ?? tx.blockTime ?? 0) * 1000;
        if (timestampMs <= 0) throw new Error("Missing swap timestamp");
        rawSwaps.push({ poolId: pool.id, txKey: `${info.signature}:${swap.instructionIndex}`,
          blockNumber: BigInt(info.slot), logIndex: txIndex * 100000 + swap.instructionIndex,
          bucketStart: bucketStartOf(timestampMs), priceUsd, volumeUsd,
          isBuy: pool.baseToken === pool.token1 ? swap.zeroForOne : !swap.zeroForOne });
        swaps++;
        if (token0Usd > 0) { price = token0Usd; at = new Date(timestampMs); }
      }
    }

    return { swaps, price, at };
  }

  // ─── Backfill ──────────────────────────────────────────────────────────────

  /**
   * Walks each pool's signature history downward, into the past.
   *
   * Per pool rather than per chain, for the same reason `lastSignature` is:
   * `getSignaturesForAddress` is an account-level query, and pools discovered
   * at different times reach the window at different times. A chain-wide mark
   * could not say which of them still has walking to do.
   *
   * Bounded to `maxBackfillSourcesPerRun` pools per tick, deepest first — a
   * chain tracking three hundred pools would otherwise multiply its request
   * count by the moment backfill started, and the deep pools are the ones whose
   * history the columns are actually reporting.
   */
  private async backfillStep(): Promise<BackfillRun> {
    const none: BackfillRun = { swapsIngested: 0, bucketsWritten: 0, poolsDiscovered: 0 };
    if (!backfillEnabled(this.settings)) return none;

    const db = DatabaseService.getInstance();
    const rows = await db.prisma.indexedPool.findMany({
      where: { chainId: this.chainId, backfillDone: false, OR: [{ backfillSignature: { not: null } }, { lastSignature: { not: null } }] },
      orderBy: [{ liquidityUsd: { sort: "desc", nulls: "last" } }, { id: "asc" }],
      take: this.settings.maxBackfillSourcesPerRun,
    });
    if (rows.length === 0) return none;

    const cutoffMs = backfillCutoffMs(this.settings);
    const usd = await this.usdPrices([]);
    const rawSwaps: RawSwap[] = [];
    const updates: { id: number; backfillSignature: string; backfillDone: boolean }[] = [];
    let swapsIngested = 0;

    for (const row of rows) {
      // Pools that predate this feature have no seed, and seeding from
      // `lastSignature` would walk down through everything already ingested.
      // The oldest swap we hold for the pool is the same boundary, recorded.
      const from = row.backfillSignature ?? (await this.oldestStoredSignature(row.id));
      if (!from) continue;

      try {
        const walked = await this.backfillPool(
          {
            id: row.id,
            poolAddress: row.poolAddress,
            token0: row.token0,
            token1: row.token1,
            decimals0: row.decimals0,
            decimals1: row.decimals1,
            lastSignature: row.lastSignature,
            programId: row.programId, vault0: row.vault0, vault1: row.vault1, baseToken: row.baseToken,
          },
          from,
          cutoffMs,
          usd,
          rawSwaps
        );

        swapsIngested += walked.swaps;
        updates.push({
          id: row.id,
          backfillSignature: walked.signature ?? from,
          backfillDone: walked.done,
        });
      } catch (error) {
        // The pool keeps its resume point, so the same page is retried next
        // tick rather than skipped.
        logger.debug("[indexer] solana backfill failed", {
          chainId: this.chainId,
          pool: row.poolAddress,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const bucketsWritten = await persistSwaps(rawSwaps);

    if (updates.length > 0) {
      await db.prisma.$transaction(
        updates.map((u) =>
          db.prisma.indexedPool.update({
            where: { id: u.id },
            // Nothing here means *latest*: a walk through last week's trades
            // must not move a pool's current price, liquidity or last-traded
            // time backwards. The EVM walk skips the same fields.
            data: { backfillSignature: u.backfillSignature, backfillDone: u.backfillDone },
          })
        )
      );
    }

    const finished = updates.filter((u) => u.backfillDone).length;
    if (swapsIngested > 0 || finished > 0) {
      logger.info("[indexer] backfilled", {
        chainId: this.chainId,
        pools: updates.length,
        swaps: swapsIngested,
        finished,
      });
    }

    return { swapsIngested, bucketsWritten, poolsDiscovered: 0 };
  }

  /** One pool's downward step: the page below `before`, priced and stored. */
  private async backfillPool(
    pool: SolanaPool,
    before: string,
    cutoffMs: number | null,
    usd: Map<string, number>,
    rawSwaps: RawSwap[]
  ): Promise<{ swaps: number; signature: string | null; done: boolean }> {
    const signatures = await this.rpc<SignatureInfo[]>("getSignaturesForAddress", [
      pool.poolAddress,
      { before, limit: Math.min(1000, this.settings.maxTxPerRun), commitment: "finalized" },
    ]);

    // Newest first from the RPC, so the last entry is the oldest — and it is
    // the one that decides whether the window has been reached. Nothing below
    // this point means the pool's history is exhausted, which is as finished as
    // a walk can be.
    const oldest = signatures.at(-1);
    if (!oldest) return { swaps: 0, signature: null, done: true };

    const inWindow = (info: SignatureInfo): boolean =>
      cutoffMs === null || (info.blockTime ?? 0) * 1000 >= cutoffMs;

    const done = !inWindow(oldest) || signatures.length < Math.min(1000, this.settings.maxTxPerRun);

    const batch = signatures
      .filter((info) => !info.err && inWindow(info))
      .reverse();

    const decoded =
      batch.length > 0
        ? await this.decodeBatch(pool, batch, usd, rawSwaps)
        : { swaps: 0, price: null, at: null };

    return { swaps: decoded.swaps, signature: oldest.signature, done };
  }

  /** The oldest swap we already hold for a pool, by its on-chain signature. */
  private async oldestStoredSignature(poolId: number): Promise<string | null> {
    const oldest = await DatabaseService.getInstance().prisma.indexedSwap.findFirst({
      where: { poolId },
      orderBy: { blockNumber: "asc" },
      select: { txKey: true },
    });
    return oldest?.txKey ?? null;
  }

  /**
   * USD price per mint. Stables anchor at 1; the wrapped native is resolved the
   * same way the EVM indexer resolves its own, and everything else is priced by
   * the pool it traded in.
   *
   * SOL matters more here than the wrapped native does on an EVM chain, and its
   * absence is why this method used to under-report. Jupiter routes most pairs
   * through a SOL leg, so a discovered pool is far more likely to be quoted in
   * SOL than in USDC — and with SOL unpriced, `decodeBatch` found neither side
   * in this map, wrote `priceUsd: 0` and `volumeUsd: 0`, and the rollup
   * faithfully reported `volume24h: null` for the whole chain. Nothing was
   * broken and nothing was logged; Solana simply had no numbers.
   */
  private async usdPrices(pools: SolanaPool[]): Promise<Map<string, number>> {
    const usd = new Map<string, number>();

    const stable = await this.mintFor(this.descriptor.stableSymbol);
    if (stable) usd.set(stable, 1);

    // A second stable is worth anchoring too: many Solana pairs quote against
    // USDT rather than USDC, and without it those pools price at nothing.
    const usdt = await this.mintFor("USDT");
    if (usdt) usd.set(usdt, 1);

    // Both spellings: pools name wrapped SOL by its mint, and the catalogue
    // may carry either symbol depending on which provider listed it.
    const nativeMints = [
      await this.mintFor(this.descriptor.nativeSymbol),
      await this.mintFor(`W${this.descriptor.nativeSymbol}`),
      WRAPPED_SOL_MINT,
    ].filter((mint): mint is string => Boolean(mint));

    // One canonical spelling on both sides. `resolveNativeUsd` decides whether
    // to invert a pool's price by comparing its token0 against this value, so
    // an anchor row labelled with a different (but equally native) mint would
    // be inverted — turning a $104 SOL into a $0.0096 one and mispricing every
    // token on the chain by that factor, silently.
    const canonicalNative = nativeMints[0] ?? WRAPPED_SOL_MINT;
    const anchorPools = await this.nativeAnchorPools(nativeMints, usd, canonicalNative);

    const nativeUsd = await resolveNativeUsd({
      descriptor: this.descriptor,
      anchorPools,
      wrappedNative: canonicalNative,
      stables: new Set(usd.keys()),
    });

    if (nativeUsd != null) {
      for (const mint of new Set(nativeMints)) usd.set(mint, nativeUsd);
    }

    void pools;
    return usd;
  }

  /**
   * Local native/stable pools, in the shape `resolveNativeUsd` expects.
   *
   * `lastPrice0` on Solana is already a USD price rather than a token0/token1
   * ratio, so a native/stable pool's stored price is the anchor directly. It is
   * presented as `token0 === wrappedNative` so the resolver reads it without
   * inverting.
   */
  private async nativeAnchorPools(
    nativeMints: string[],
    stables: Map<string, number>,
    canonicalNative: string
  ): Promise<{ token0: string; lastPrice0: number | null; liquidityUsd: number | null }[]> {
    const stableMints = [...stables.keys()];
    if (nativeMints.length === 0 || stableMints.length === 0) return [];

    const rows = await DatabaseService.getInstance().prisma.indexedPool.findMany({
      where: {
        chainId: this.chainId,
        OR: [
          { token0: { in: nativeMints }, token1: { in: stableMints } },
          { token0: { in: stableMints }, token1: { in: nativeMints } },
        ],
      },
      select: { token0: true, token1: true, lastPrice0: true, liquidityUsd: true },
    });

    const native = new Set(nativeMints);

    return rows.map((row) => ({
      // Always the canonical spelling, whichever the pool happens to use, so
      // the resolver's token0 comparison cannot mistake a native side for a
      // non-native one and invert the price.
      token0: canonicalNative,
      // lastPrice0 is the USD price of token0. When the native side is token1
      // the stored price describes the stable, which is ~1 and tells us
      // nothing — so those rows carry no anchor.
      lastPrice0: native.has(row.token0) ? row.lastPrice0 : null,
      liquidityUsd: row.liquidityUsd,
    }));
  }

  private async saveCursor(lastBlock: bigint): Promise<void> {
    await DatabaseService.getInstance().prisma.indexerCursor.upsert({
      where: { chainId: this.chainId },
      create: { chainId: this.chainId, lastBlock, lastPoolBlock: lastBlock },
      update: { lastBlock },
    });
  }
}
