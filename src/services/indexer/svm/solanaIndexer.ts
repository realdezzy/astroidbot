import { DatabaseService } from "../../db.js";
import { logger } from "../../../utils/logger.js";
import { persistSwaps, type RawSwap } from "../swapStore.js";
import { bucketStartOf } from "../types.js";
import {
  decodeSolanaSwap,
  probeDecodable,
  type SolanaTransactionMeta,
} from "./balanceDeltas.js";
import type { BackfillRun, ChainIndexer, IndexRunResult } from "../types.js";
import { backfillCutoffMs, backfillEnabled, type IndexerSettings } from "../settings.js";
import type { ChainDescriptor, ChainId } from "../../../types/chain.js";
import { requireSvmConfig } from "../../../types/chain.js";

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
}

/**
 * Signatures per `getSignaturesForAddress` call. The RPC caps this at 1000, and
 * listing is cheap — it is fetching each transaction's body that costs.
 */
const SIGNATURE_PAGE_SIZE = 1_000;

/**
 * Pages the forward pass will walk to reach its `until` mark.
 *
 * A pool that has produced more than a million signatures since the last tick
 * is not one this indexer can catch up on within a tick anyway, and the bound
 * stops a misconfigured cursor from paging an account's entire history.
 */
const MAX_SIGNATURE_PAGES = 20;

/** What one pool's forward pass learned, written back after the batch. */
interface PoolProgress {
  /** Newest signature *read* this pass, decodable or not. */
  signature: string;
  /** Newest price decoded, or null if nothing in the batch priced. */
  price: number | null;
  at: Date | null;
  /** Where the downward walk starts. Set only on a pool's first pass. */
  backfillSeed?: string;
}

export class SolanaIndexer implements ChainIndexer {
  readonly chainId: ChainId;
  private readonly svm;

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
    const key = `RPC_URL_${this.chainId.toUpperCase().replace(/[:-]/g, "_")}`;
    return process.env[key] || this.svm.defaultRpcUrl;
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

    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        calls.map((call, id) => ({ jsonrpc: "2.0", id, method: call.method, params: call.params }))
      ),
    });

    if (!response.ok) throw new Error(`Solana RPC ${response.status} for batch`);

    const body = (await response.json()) as { id: number; result?: T; error?: unknown }[];

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
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

    if (!response.ok) throw new Error(`Solana RPC ${response.status} for ${method}`);

    const body = (await response.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`Solana RPC ${method}: ${body.error.message ?? "error"}`);
    return body.result as T;
  }

  async run(): Promise<IndexRunResult> {
    const db = DatabaseService.getInstance();
    const slot = await this.rpc<number>("getSlot", [{ commitment: "finalized" }]);

    const cursor = await db.prisma.indexerCursor.findUnique({
      where: { chainId: this.chainId },
    });

    if (!cursor) {
      await db.prisma.indexerCursor.create({
        data: {
          chainId: this.chainId,
          lastBlock: BigInt(slot),
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

    return this.result(
      poolsDiscovered,
      swapsIngested + backfilled.swapsIngested,
      bucketsWritten + backfilled.bucketsWritten,
      cursor?.lastBlock ?? BigInt(slot),
      BigInt(slot)
    );
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
    const db = DatabaseService.getInstance();

    const tokens = await db.prisma.indexedToken.findMany({
      where: { chainId: this.chainId },
      orderBy: { volume24h: { sort: "desc", nulls: "last" } },
      take: 25,
    });

    // Seeded from the descriptor's own pair on first run, before any token has
    // been catalogued. Without this the indexer would never start: it would
    // have no tokens because it had ingested nothing, and ingest nothing
    // because it had no pools.
    const quoteMint = await this.mintFor(this.descriptor.stableSymbol);
    const baseMint = await this.mintFor(this.descriptor.nativeSymbol);
    if (!quoteMint || !baseMint) return 0;

    const candidates = tokens.length > 0 ? tokens.map((t) => t.contractId) : [baseMint];

    let discovered = 0;

    for (const mint of candidates.slice(0, this.settings.maxPools)) {
      if (mint === quoteMint) continue;

      try {
        discovered += await this.discoverForPair(mint, quoteMint);
      } catch (error) {
        logger.debug("[indexer] solana pool discovery failed for pair", {
          chainId: this.chainId,
          mint,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return discovered;
  }

  private async discoverForPair(inputMint: string, outputMint: string): Promise<number> {
    const db = DatabaseService.getInstance();
    const api = this.svm.jupiterApiUrl!.replace(/\/$/, "");

    // A deliberately small probe. The route a large trade takes is the route
    // through the deepest pool, but asking for a large trade on a thin pair
    // returns nothing at all — and a pair with only thin liquidity is still a
    // pair we want to price.
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: "1000000",
      slippageBps: "500",
      onlyDirectRoutes: "true",
    });

    const response = await fetch(`${api}/quote?${params}`);
    if (!response.ok) return 0;

    const quote = (await response.json()) as {
      routePlan?: {
        swapInfo?: { ammKey?: string; label?: string; inputMint?: string; outputMint?: string };
      }[];
    };

    let discovered = 0;

    for (const hop of quote.routePlan ?? []) {
      const info = hop.swapInfo;
      if (!info?.ammKey || !info.inputMint || !info.outputMint) continue;

      const existing = await db.prisma.indexedPool.findFirst({
        where: { chainId: this.chainId, poolAddress: info.ammKey },
        select: { id: true },
      });
      if (existing) continue;

      const [decimals0, decimals1] = await Promise.all([
        this.mintDecimals(info.inputMint),
        this.mintDecimals(info.outputMint),
      ]);
      if (decimals0 === null || decimals1 === null) continue;

      // A venue whose vaults sit under a shared program authority rather than
      // under the pool decodes to nothing here, and would otherwise be polled
      // every tick forever while contributing no swaps — the silent gap this
      // codebase keeps getting bitten by. One probe against recent history
      // turns it into a pool that was never tracked, which is visible.
      if (!(await this.canDecodePool(info.ammKey, info.inputMint, info.outputMint))) {
        logger.info("[indexer] solana pool not decodable from balance deltas, skipping", {
          chainId: this.chainId,
          pool: info.ammKey,
          dex: info.label,
        });
        continue;
      }

      try {
        await db.prisma.indexedPool.create({
          data: {
            chainId: this.chainId,
            dexId: (info.label ?? "jupiter").toLowerCase(),
            poolAddress: info.ammKey,
            token0: info.inputMint,
            token1: info.outputMint,
            decimals0,
            decimals1,
            baseToken: info.inputMint === outputMint ? info.outputMint : info.inputMint,
            quoteToken: outputMint,
          },
        });
        discovered++;
      } catch {
        // Concurrent discovery won the race; the unique key arbitrates.
      }
    }

    return discovered;
  }

  /**
   * Whether this pool's swaps can be read from balance deltas at all.
   *
   * Checked once, at discovery. The cost is a handful of transaction fetches
   * against a pool we are deciding whether to follow for good.
   */
  private async canDecodePool(
    poolAddress: string,
    token0: string,
    token1: string
  ): Promise<boolean> {
    try {
      const signatures = await this.rpc<SignatureInfo[]>("getSignaturesForAddress", [
        poolAddress,
        { limit: 10 },
      ]);

      const metas: SolanaTransactionMeta[] = [];
      for (const info of signatures.filter((s) => !s.err).slice(0, 5)) {
        const tx = await this.rpc<{ meta?: SolanaTransactionMeta } | null>("getTransaction", [
          info.signature,
          { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" },
        ]);
        if (tx?.meta) metas.push(tx.meta);
      }

      // No recent activity is not the same as undecodable. A brand-new pool
      // with no trades yet is worth following; refusing it here would mean
      // never picking up a pair at the moment it starts moving.
      if (metas.length === 0) return true;

      return probeDecodable(metas, poolAddress, token0, token1);
    } catch {
      // An RPC failure is not evidence about the pool. Track it and let
      // ingestion decide.
      return true;
    }
  }

  /** Mint decimals, straight from the SPL mint account. */
  private async mintDecimals(mint: string): Promise<number | null> {
    try {
      const account = await this.rpc<{
        value?: { data?: { parsed?: { info?: { decimals?: number } } } };
      }>("getAccountInfo", [mint, { encoding: "jsonParsed" }]);

      const decimals = account?.value?.data?.parsed?.info?.decimals;
      return typeof decimals === "number" ? decimals : null;
    } catch {
      return null;
    }
  }

  /** Resolves a symbol to its mint through the chain's DEX provider list. */
  private async mintFor(symbol: string): Promise<string | null> {
    const { DEXRegistry } = await import("../../dex/dexRegistry.js");
    const tokens = await DEXRegistry.getInstance()
      .getSwappableTokens(false, this.chainId)
      .catch(() => []);

    return tokens.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase())?.contractId ?? null;
  }

  private async trackedPools(): Promise<SolanaPool[]> {
    const rows = await DatabaseService.getInstance().prisma.indexedPool.findMany({
      where: { chainId: this.chainId },
      orderBy: [{ lastSwapAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
      take: this.settings.maxPools,
    });

    return rows.map((r) => ({
      id: r.id,
      poolAddress: r.poolAddress,
      token0: r.token0,
      token1: r.token1,
      decimals0: r.decimals0,
      decimals1: r.decimals1,
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

    for (const pool of pools) {
      try {
        const result = await this.ingestPool(pool, usd, rawSwaps);
        swapsIngested += result.swaps;
        if (result.progress) {
          poolState.set(pool.id, result.progress);
        }
      } catch (error) {
        logger.debug("[indexer] solana pool ingest failed", {
          chainId: this.chainId,
          pool: pool.poolAddress,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const bucketsWritten = await persistSwaps(rawSwaps);

    await db.prisma.$transaction([
      ...[...poolState.entries()].map(([poolId, state]) =>
        db.prisma.indexedPool.update({
          where: { id: poolId },
          data: {
            lastSignature: state.signature,
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
      db.prisma.indexerCursor.upsert({
        where: { chainId: this.chainId },
        create: { chainId: this.chainId, lastBlock: slot, lastPoolBlock: slot },
        update: { lastBlock: slot },
      }),
    ]);

    return { swapsIngested, bucketsWritten };
  }

  private async ingestPool(
    pool: SolanaPool,
    usd: Map<string, number>,
    rawSwaps: RawSwap[]
  ): Promise<{ swaps: number; progress: PoolProgress | null }> {
    const db = DatabaseService.getInstance();

    const stored = await db.prisma.indexedPool.findUnique({
      where: { id: pool.id },
      select: { lastSignature: true },
    });

    const signatures = await this.newSignatures(pool.poolAddress, stored?.lastSignature ?? null);
    if (signatures.length === 0) return { swaps: 0, progress: null };

    // Newest first from the RPC; applied oldest-first so a bucket's `open` is
    // the first trade in it rather than the last.
    //
    // The budget is applied to the *oldest* end, so progress is contiguous with
    // where the last tick stopped. Taking the newest instead — which is what a
    // bare `limit` on the RPC call does — leaves the middle unread and no
    // cursor able to describe the hole, so a pool busier than one tick's budget
    // silently loses every swap in between.
    const ordered = [...signatures].reverse().filter((info) => !info.err);
    const batch = ordered.slice(0, this.settings.maxTxPerRun);

    const newestRead = batch.at(-1);
    if (!newestRead) return { swaps: 0, progress: null };

    const decoded = await this.decodeBatch(pool, batch, usd, rawSwaps);

    return {
      swaps: decoded.swaps,
      progress: {
        // Every signature in the batch has been read, whether or not it held a
        // decodable swap, so the cursor advances past all of them. Advancing
        // only on a decoded swap would leave a pool of undecodable traffic
        // re-reading the same page every tick, forever.
        signature: newestRead.signature,
        price: decoded.price,
        at: decoded.at,
        // Only meaningful on the first pass; `undefined` on every later one so
        // the write is skipped rather than resetting the walk.
        backfillSeed: stored?.lastSignature ? undefined : signatures.at(-1)?.signature,
      },
    };
  }

  /**
   * Every signature newer than `until`, newest first.
   *
   * Paged, because `getSignaturesForAddress` returns at most `limit` of the
   * *newest* signatures and silently omits the rest. Listing is one request per
   * thousand signatures; the expense is fetching transaction bodies, which the
   * caller bounds separately.
   *
   * With no `until` there is nothing to page towards — that is a pool's first
   * pass, and the newest page is the intended starting window rather than an
   * invitation to walk its entire history.
   */
  private async newSignatures(poolAddress: string, until: string | null): Promise<SignatureInfo[]> {
    if (!until) {
      return this.rpc<SignatureInfo[]>("getSignaturesForAddress", [
        poolAddress,
        { limit: this.settings.maxTxPerRun },
      ]);
    }

    const all: SignatureInfo[] = [];
    let before: string | undefined;

    for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
      const params: Record<string, unknown> = { limit: SIGNATURE_PAGE_SIZE, until };
      if (before) params.before = before;

      const batch = await this.rpc<SignatureInfo[]>("getSignaturesForAddress", [
        poolAddress,
        params,
      ]);

      const oldest = batch.at(-1);
      if (!oldest) break;

      all.push(...batch);
      if (batch.length < SIGNATURE_PAGE_SIZE) break;

      before = oldest.signature;
    }

    return all;
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
    const transactions = await this.rpcBatch<{ meta?: SolanaTransactionMeta; blockTime?: number }>(
      batch.map((info) => ({
        method: "getTransaction",
        params: [info.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }],
      }))
    );

    let swaps = 0;
    let price: number | null = null;
    let at: Date | null = null;

    for (const [index, info] of batch.entries()) {
      const tx = transactions[index];
      if (!tx?.meta) continue;

      const swap = decodeSolanaSwap(tx.meta, pool.poolAddress, pool.token0, pool.token1);
      if (!swap) continue;

      const amount0 = Number(swap.amount0) / 10 ** pool.decimals0;
      const amount1 = Number(swap.amount1) / 10 ** pool.decimals1;
      if (amount0 <= 0 || amount1 <= 0) continue;

      const price0 = usd.get(pool.token0);
      const price1 = usd.get(pool.token1);
      const priceUsd = price0 ?? (price1 ? (amount1 / amount0) * price1 : 0);
      const volumeUsd = price0 ? amount0 * price0 : price1 ? amount1 * price1 : 0;

      const timestampMs = (info.blockTime ?? tx.blockTime ?? 0) * 1000;
      if (timestampMs <= 0) continue;

      rawSwaps.push({
        poolId: pool.id,
        // The signature is the swap's identity, so a replayed window inserts
        // nothing rather than double-counting it.
        txKey: info.signature,
        blockNumber: BigInt(info.slot),
        logIndex: 0,
        bucketStart: bucketStartOf(timestampMs),
        priceUsd,
        volumeUsd,
        isBuy: !swap.zeroForOne,
      });
      swaps++;

      if (priceUsd > 0) {
        price = priceUsd;
        at = new Date(timestampMs);
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
      where: { chainId: this.chainId, backfillDone: false },
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
      { before, limit: this.settings.maxTxPerRun },
    ]);

    // Newest first from the RPC, so the last entry is the oldest — and it is
    // the one that decides whether the window has been reached. Nothing below
    // this point means the pool's history is exhausted, which is as finished as
    // a walk can be.
    const oldest = signatures.at(-1);
    if (!oldest) return { swaps: 0, signature: null, done: true };

    const inWindow = (info: SignatureInfo): boolean =>
      cutoffMs === null || (info.blockTime ?? 0) * 1000 >= cutoffMs;

    const done = !inWindow(oldest) || signatures.length < this.settings.maxTxPerRun;

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
   * USD price per mint. Stables anchor at 1; everything else is priced by the
   * pool it traded in, and a mint with no priceable counterparty gets none.
   */
  private async usdPrices(pools: SolanaPool[]): Promise<Map<string, number>> {
    const usd = new Map<string, number>();
    const stable = await this.mintFor(this.descriptor.stableSymbol);
    if (stable) usd.set(stable, 1);

    // A second stable is worth anchoring too: many Solana pairs quote against
    // USDT rather than USDC, and without it those pools price at nothing.
    const usdt = await this.mintFor("USDT");
    if (usdt) usd.set(usdt, 1);

    void pools;
    return usd;
  }

  private async saveCursor(lastBlock: bigint): Promise<void> {
    await DatabaseService.getInstance().prisma.indexerCursor.upsert({
      where: { chainId: this.chainId },
      create: { chainId: this.chainId, lastBlock, lastPoolBlock: lastBlock },
      update: { lastBlock },
    });
  }
}
