import { DatabaseService } from "../db.js";
import { logger } from "../../utils/logger.js";
import { DEFAULT_CHAIN_ID } from "../chains/descriptors/index.js";
import { BUCKET_MS } from "../indexer/types.js";

/**
 * Timeframe to span. `BUCKET_MS` (five minutes) is the index's resolution, so
 * it is also the floor: anything below it cannot be served without inventing
 * the difference.
 */
/** The columns every candle read needs, named once. */
const BUCKET_FIELDS = {
  bucketStart: true,
  open: true,
  high: true,
  low: true,
  close: true,
  volumeUsd: true,
} as const;

const TIMEFRAME_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export interface CandleData {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: Date;
}

export class CandleService {
  private static instance: CandleService;

  private constructor() {}

  static getInstance(): CandleService {
    if (!CandleService.instance) {
      CandleService.instance = new CandleService();
    }
    return CandleService.instance;
  }

  /**
   * Rounds a timestamp down to the nearest timeframe interval
   */
  getPeriodStart(timestamp: number, timeframe: string): Date {
    const date = new Date(timestamp);
    const m = date.getUTCMinutes();
    const h = date.getUTCHours();

    switch (timeframe) {
      case "1m":
        date.setUTCSeconds(0, 0);
        break;
      case "5m":
        date.setUTCMinutes(m - (m % 5), 0, 0);
        break;
      case "15m":
        date.setUTCMinutes(m - (m % 15), 0, 0);
        break;
      case "1h":
        date.setUTCMinutes(0, 0, 0);
        break;
      case "4h":
        date.setUTCHours(h - (h % 4), 0, 0, 0);
        break;
      case "1d":
        date.setUTCHours(0, 0, 0, 0);
        break;
      default:
        date.setUTCSeconds(0, 0);
    }
    return date;
  }

  /**
   * Historical candles for a token, from the swap index.
   *
   * These used to come from the `Candle` table, and when that table had no
   * rows `autoSeed` generated some with `Math.random()` — prices as a random
   * walk from spot, and a volume of `1000 + Math.random() * 10000`, which is
   * not an approximation of anything. They were written with `createMany`, so
   * the fabrication persisted and nothing downstream could tell it from a
   * measurement. `recordPrice` is the only thing that would ever have written
   * real rows there, and nothing calls it, so every row in that table was
   * invented.
   *
   * They now come from `PoolCandle`, which the indexer folds from swap logs it
   * actually read. When the index has nothing, this returns nothing: an empty
   * chart is a true statement about a token nobody has traded, and an invented
   * one is not.
   *
   * Price comes from the token's deepest pool, which is the same rule
   * `RollupService` uses — averaging a deep pool with a dust pool moves the
   * quoted price toward one nobody can trade at.
   */
  async getCandles(
    token: string,
    timeframe: string,
    limit = 100,
    chainId: string = DEFAULT_CHAIN_ID
  ): Promise<CandleData[]> {
    const intervalMs = TIMEFRAME_MS[timeframe];

    // The index's finest resolution is a five-minute bucket. Anything finer
    // would have to be interpolated, which is the thing this method stopped
    // doing.
    if (!intervalMs || intervalMs < BUCKET_MS) {
      logger.debug("[candles] timeframe finer than the index records", { token, timeframe });
      return [];
    }

    const poolId = await this.deepestPoolFor(token, chainId);
    if (poolId === null) return [];

    // Over-read deliberately: `limit` counts aggregated candles, and each one
    // consumes `intervalMs / BUCKET_MS` buckets.
    const bucketsPerCandle = Math.max(1, Math.round(intervalMs / BUCKET_MS));
    const rows = await DatabaseService.getInstance().prisma.poolCandle.findMany({
      where: { poolId },
      orderBy: { bucketStart: "desc" },
      take: limit * bucketsPerCandle,
      select: BUCKET_FIELDS,
    });
    if (rows.length === 0) return [];

    return this.aggregate(rows.reverse(), timeframe).slice(-limit);
  }

  /**
   * The same candles, bounded by a date range rather than a count.
   *
   * Backtests need this shape: "every candle between these two dates" cannot
   * be expressed as a limit, because how many candles that is depends on how
   * much the token traded. It shares pool resolution and aggregation with
   * `getCandles` so a backtest and a chart of the same window cannot disagree.
   */
  async getCandlesBetween(
    token: string,
    timeframe: string,
    startDate: Date,
    endDate: Date,
    chainId: string = DEFAULT_CHAIN_ID
  ): Promise<CandleData[]> {
    const intervalMs = TIMEFRAME_MS[timeframe];
    if (!intervalMs || intervalMs < BUCKET_MS) {
      logger.debug("[candles] timeframe finer than the index records", { token, timeframe });
      return [];
    }

    const poolId = await this.deepestPoolFor(token, chainId);
    if (poolId === null) return [];

    const rows = await DatabaseService.getInstance().prisma.poolCandle.findMany({
      where: { poolId, bucketStart: { gte: startDate, lte: endDate } },
      orderBy: { bucketStart: "asc" },
      select: BUCKET_FIELDS,
    });
    if (rows.length === 0) return [];

    return this.aggregate(rows, timeframe);
  }

  /**
   * The id of the deepest pool trading this symbol on this chain.
   *
   * The index keys pools by contract address while callers ask by symbol, so
   * the symbol is resolved through `IndexedToken` first. Deepest rather than
   * first because that is the rule `RollupService` applies when it decides a
   * token's price — averaging a deep pool with a dust pool moves the quote
   * toward one nobody can trade at, and a chart disagreeing with the price
   * column above it is worse than either.
   */
  private async deepestPoolFor(token: string, chainId: string): Promise<number | null> {
    const db = DatabaseService.getInstance();

    const indexed = await db.prisma.indexedToken.findFirst({
      where: { chainId, symbol: { equals: token.toUpperCase(), mode: "insensitive" } },
      select: { contractId: true },
    });
    if (!indexed) return null;

    const pool = await db.prisma.indexedPool.findFirst({
      where: { chainId, baseToken: indexed.contractId },
      orderBy: { liquidityUsd: { sort: "desc", nulls: "last" } },
      select: { id: true },
    });

    return pool?.id ?? null;
  }

  /**
   * Folds five-minute buckets into wider candles.
   *
   * Open is the first bucket's open and close is the last bucket's close —
   * not the extremes of the window. Taking the high as the open produces a
   * chart that looks entirely plausible and is wrong, which is the worst
   * available outcome.
   *
   * Input must be chronological.
   */
  private aggregate(
    rows: {
      bucketStart: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volumeUsd: number;
    }[],
    timeframe: string
  ): CandleData[] {
    const out: CandleData[] = [];
    let current: CandleData | null = null;
    let currentStart = -1;

    for (const row of rows) {
      const periodStart = this.getPeriodStart(row.bucketStart.getTime(), timeframe).getTime();

      if (!current || periodStart !== currentStart) {
        if (current) out.push(current);
        currentStart = periodStart;
        current = {
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volumeUsd,
          timestamp: new Date(periodStart),
        };
        continue;
      }

      current.high = Math.max(current.high, row.high);
      current.low = Math.min(current.low, row.low);
      current.close = row.close;
      current.volume += row.volumeUsd;
    }

    if (current) out.push(current);
    return out;
  }
}
