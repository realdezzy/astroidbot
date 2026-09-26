import { DatabaseService } from "../../db.js";
import { BUCKET_MS, timeframeMs } from "./interval.js";
import type { CandleData, CandleQuery, CandleSource } from "./types.js";

/**
 * Candles from our own swap index.
 *
 * These queries are `CandleService`'s former body, moved here unchanged. That
 * matters more than it looks: this class *is* the rollback path. If the
 * external source turns out to disagree with what actually traded, flipping
 * `CANDLE_SOURCE` back to `internal` has to restore exactly today's numbers,
 * and it only does that if nothing about the reads was "improved" on the way
 * across.
 *
 * Price comes from the token's deepest pool, which is the rule `RollupService`
 * uses — averaging a deep pool with a dust pool moves the quoted price toward
 * one nobody can trade at, and a chart that disagrees with the price column
 * above it is worse than either.
 */
export class InternalCandleSource implements CandleSource {
  readonly name = "internal";

  /** Rows are 5-minute buckets; the caller folds them into the timeframe. */
  readonly needsAggregation = true;

  /**
   * The index's finest resolution is a five-minute bucket. Anything finer
   * would have to be interpolated, which is the thing this service stopped
   * doing when `autoSeed` and its `Math.random()` candles were removed.
   */
  supportsTimeframe(timeframe: string): boolean {
    const interval = timeframeMs(timeframe);
    return interval !== null && interval >= BUCKET_MS;
  }

  async getCandles(
    query: CandleQuery,
    timeframe: string,
    limit: number
  ): Promise<CandleData[]> {
    const interval = timeframeMs(timeframe);
    if (interval === null) return [];

    const poolId = await this.deepestPoolFor(query);
    if (poolId === null) return [];

    // Over-read deliberately: `limit` counts aggregated candles, and each one
    // consumes `interval / BUCKET_MS` buckets.
    const bucketsPerCandle = Math.max(1, Math.round(interval / BUCKET_MS));
    const rows = await DatabaseService.getInstance().prisma.poolCandle.findMany({
      where: { poolId },
      orderBy: { bucketStart: "desc" },
      take: limit * bucketsPerCandle,
      select: BUCKET_FIELDS,
    });
    if (rows.length === 0) return [];

    return rows.reverse().map(toCandle);
  }

  async getCandlesBetween(
    query: CandleQuery,
    _timeframe: string,
    startDate: Date,
    endDate: Date
  ): Promise<CandleData[]> {
    const poolId = await this.deepestPoolFor(query);
    if (poolId === null) return [];

    const rows = await DatabaseService.getInstance().prisma.poolCandle.findMany({
      where: { poolId, bucketStart: { gte: startDate, lte: endDate } },
      orderBy: { bucketStart: "asc" },
      select: BUCKET_FIELDS,
    });

    return rows.map(toCandle);
  }

  /**
   * The id of the deepest pool trading this token on this chain.
   *
   * A caller that already knows the contract address says so; the index keys
   * pools by address while the feature engine and the backtester ask by
   * symbol, so a symbol is resolved through `IndexedToken` first.
   */
  private async deepestPoolFor(query: CandleQuery): Promise<number | null> {
    const db = DatabaseService.getInstance();

    const contractId = query.contractId
      ? query.contractId.toLowerCase()
      : await this.contractForSymbol(query);
    if (!contractId) return null;

    const pool = await db.prisma.indexedPool.findFirst({
      where: { chainId: query.chainId, baseToken: contractId },
      orderBy: { liquidityUsd: { sort: "desc", nulls: "last" } },
      select: { id: true },
    });

    return pool?.id ?? null;
  }

  private async contractForSymbol(query: CandleQuery): Promise<string | null> {
    if (!query.symbol) return null;

    const indexed = await DatabaseService.getInstance().prisma.indexedToken.findFirst({
      where: {
        chainId: query.chainId,
        symbol: { equals: query.symbol.toUpperCase(), mode: "insensitive" },
      },
      select: { contractId: true },
    });

    return indexed?.contractId ?? null;
  }
}

/** The columns every candle read needs, named once. */
const BUCKET_FIELDS = {
  bucketStart: true,
  open: true,
  high: true,
  low: true,
  close: true,
  volumeUsd: true,
} as const;

function toCandle(row: {
  bucketStart: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}): CandleData {
  return {
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volumeUsd,
    timestamp: row.bucketStart,
  };
}
