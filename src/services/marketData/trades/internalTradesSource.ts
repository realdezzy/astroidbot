import { DatabaseService } from "../../db.js";
import type { SwapFeed, TokenTrader, TraderFeed, TradesSource } from "./types.js";

/**
 * How far back the per-token activity panels look.
 *
 * These render "recent trades" and "top traders", so a window is what they
 * actually mean — and without one the queries behind them scan every swap
 * retained for the token's pools, which grows with the product's success
 * rather than with the size of the answer.
 */
const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

function recentWindow(): Date {
  return new Date(Date.now() - ACTIVITY_WINDOW_MS);
}

/** Said when the token has no pools in our index, which is not the same as no trades. */
const NO_POOLS = "No indexed pools found for this token.";

/**
 * Activity from our own swap index — the route handler's former body, moved
 * behind the interface unchanged.
 *
 * Unchanged on purpose: this is what `INDEXER_MODE=full` restores. Under
 * discovery mode `IndexedSwap` simply stops gaining rows, so this source
 * quietly reports the last 24 hours it managed to ingest and then nothing —
 * which is why the external source exists rather than this one being taught to
 * cope.
 */
export class InternalTradesSource implements TradesSource {
  readonly name = "internal";

  async recentSwaps(chainId: string, contractId: string, limit: number): Promise<SwapFeed> {
    const poolIds = await poolsFor(chainId, contractId);
    if (poolIds.length === 0) return { swaps: [], note: NO_POOLS };

    const rows = await DatabaseService.getInstance().prisma.indexedSwap.findMany({
      where: { poolId: { in: poolIds }, bucketStart: { gte: recentWindow() } },
      orderBy: [{ blockNumber: "desc" }, { logIndex: "desc" }],
      take: limit,
    });

    return {
      swaps: rows.map((s) => ({
        // The stored key is "<txHash>:<logIndex>"; the transaction is the half
        // an explorer link needs.
        txHash: s.txKey.split(":")[0] ?? s.txKey,
        // When the swap happened, not when we wrote the row down. `createdAt`
        // was being sent here, which is the ingestion time — so during a
        // backfill walk every trade in this list, however old, was stamped
        // "just now". Bucket resolution is five minutes, which is the
        // resolution the swap was recorded at.
        timestamp: s.bucketStart,
        isBuy: s.isBuy,
        volumeUsd: s.volumeUsd,
        priceUsd: s.priceUsd,
        traderAddress: s.traderAddress,
      })),
    };
  }

  async topTraders(chainId: string, contractId: string, limit: number): Promise<TraderFeed> {
    const poolIds = await poolsFor(chainId, contractId);
    if (poolIds.length === 0) return { traders: [], note: NO_POOLS };

    // Bounded. This is a public, unauthenticated route, and the aggregate
    // behind it used to scan every swap ever retained for the token's pools —
    // a hash aggregate over millions of rows, recomputed on every request, for
    // a leaderboard that is about recent activity anyway.
    const aggregated = await DatabaseService.getInstance().prisma.indexedSwap.groupBy({
      by: ["traderAddress"],
      where: {
        poolId: { in: poolIds },
        traderAddress: { not: null },
        bucketStart: { gte: recentWindow() },
      },
      _sum: { volumeUsd: true },
      _count: { _all: true },
      orderBy: { _sum: { volumeUsd: "desc" } },
      take: limit,
    });

    const traders: TokenTrader[] = aggregated
      .filter((row) => Boolean(row.traderAddress))
      .map((row) => ({
        address: row.traderAddress!,
        volumeUsd: row._sum.volumeUsd,
        trades: row._count._all,
      }));

    return { traders };
  }
}

/** Every indexed pool the token trades in, including one named by pool address. */
async function poolsFor(chainId: string, contractId: string): Promise<number[]> {
  const pools = await DatabaseService.getInstance().prisma.indexedPool.findMany({
    where: {
      chainId,
      OR: [
        { baseToken: contractId },
        { quoteToken: contractId },
        { poolAddress: contractId },
      ],
    },
    select: { id: true },
  });

  return pools.map((p) => p.id);
}
