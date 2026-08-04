import { DatabaseService } from "../../db.js";
import { logger } from "../../../utils/logger.js";
import { CandleAccumulator, buildCandleUpsert } from "../candleStore.js";
import { bucketStartOf } from "../types.js";
import {
  decodeSolanaSwap,
  probeDecodable,
  type SolanaTransactionMeta,
} from "./balanceDeltas.js";
import type { ChainIndexer, IndexRunResult } from "../types.js";
import type { IndexerSettings } from "../settings.js";
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

    return this.result(
      poolsDiscovered,
      swapsIngested,
      bucketsWritten,
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

    const accumulator = new CandleAccumulator();
    const poolState = new Map<number, { price: number; at: Date; signature: string }>();
    let swapsIngested = 0;

    for (const pool of pools) {
      try {
        const result = await this.ingestPool(pool, usd, accumulator);
        swapsIngested += result.swaps;
        if (result.newest) {
          poolState.set(pool.id, result.newest);
        }
      } catch (error) {
        logger.debug("[indexer] solana pool ingest failed", {
          chainId: this.chainId,
          pool: pool.poolAddress,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const buckets = accumulator.values();

    await db.prisma.$transaction([
      ...(buckets.length > 0 ? [db.prisma.$executeRaw(buildCandleUpsert(buckets))] : []),
      ...[...poolState.entries()].map(([poolId, state]) =>
        db.prisma.indexedPool.update({
          where: { id: poolId },
          data: {
            lastPrice0: state.price,
            lastSwapAt: state.at,
            lastSignature: state.signature,
          },
        })
      ),
      db.prisma.indexerCursor.upsert({
        where: { chainId: this.chainId },
        create: { chainId: this.chainId, lastBlock: slot, lastPoolBlock: slot },
        update: { lastBlock: slot },
      }),
    ]);

    return { swapsIngested, bucketsWritten: buckets.length };
  }

  private async ingestPool(
    pool: SolanaPool,
    usd: Map<string, number>,
    accumulator: CandleAccumulator
  ): Promise<{ swaps: number; newest: { price: number; at: Date; signature: string } | null }> {
    const db = DatabaseService.getInstance();

    const stored = await db.prisma.indexedPool.findUnique({
      where: { id: pool.id },
      select: { lastSignature: true },
    });

    const params: Record<string, unknown> = { limit: this.settings.maxTxPerRun };
    if (stored?.lastSignature) params.until = stored.lastSignature;

    const signatures = await this.rpc<SignatureInfo[]>("getSignaturesForAddress", [
      pool.poolAddress,
      params,
    ]);

    if (signatures.length === 0) return { swaps: 0, newest: null };

    // Newest first from the RPC; applied oldest-first so a bucket's `open` is
    // the first trade in it rather than the last.
    const ordered = [...signatures].reverse();
    let swaps = 0;
    let newest: { price: number; at: Date; signature: string } | null = null;

    for (const info of ordered) {
      if (info.err) continue;

      const tx = await this.rpc<{ meta?: SolanaTransactionMeta; blockTime?: number } | null>(
        "getTransaction",
        [info.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]
      );

      if (!tx?.meta) continue;

      const decoded = decodeSolanaSwap(tx.meta, pool.poolAddress, pool.token0, pool.token1);
      if (!decoded) continue;

      const amount0 = Number(decoded.amount0) / 10 ** pool.decimals0;
      const amount1 = Number(decoded.amount1) / 10 ** pool.decimals1;
      if (amount0 <= 0 || amount1 <= 0) continue;

      const price0 = usd.get(pool.token0);
      const price1 = usd.get(pool.token1);
      const priceUsd = price0 ?? (price1 ? (amount1 / amount0) * price1 : 0);
      const volumeUsd = price0 ? amount0 * price0 : price1 ? amount1 * price1 : 0;

      const timestampMs = (info.blockTime ?? tx.blockTime ?? 0) * 1000;
      if (timestampMs <= 0) continue;

      accumulator.add(
        pool.id,
        bucketStartOf(timestampMs),
        priceUsd,
        volumeUsd,
        !decoded.zeroForOne
      );
      swaps++;

      if (priceUsd > 0) {
        newest = { price: priceUsd, at: new Date(timestampMs), signature: info.signature };
      } else if (!newest) {
        newest = { price: 0, at: new Date(timestampMs), signature: info.signature };
      } else {
        newest.signature = info.signature;
      }
    }

    return { swaps, newest };
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
