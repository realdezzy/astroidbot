import { RedisService } from "../redis.js";
import { logger } from "../../utils/logger.js";
import { DEFAULT_CHAIN_ID } from "../chains/descriptors/index.js";
import {
  candleCacheTtlSeconds,
  resolveCandleSource,
  timeframeMs,
} from "../marketData/candles/index.js";
import type { CandleData, CandleQuery, CandleSource } from "../marketData/candles/types.js";

export type { CandleData } from "../marketData/candles/types.js";

export class CandleService {
  private static instance: CandleService;

  /** Resolved lazily: config isn't loaded when the singleton is constructed. */
  private source: CandleSource | null = null;

  private constructor() {}

  static getInstance(): CandleService {
    if (!CandleService.instance) {
      CandleService.instance = new CandleService();
    }
    return CandleService.instance;
  }

  /**
   * The configured source. Two exist and they are not peers: `internal` reads
   * the candles our own indexer folded from swap logs, and `geckoterminal`
   * buys the same series from an API. Which one answers is a config decision,
   * which is what makes flipping back a one-line change rather than a revert.
   */
  candleSource(): CandleSource {
    if (!this.source) this.source = resolveCandleSource();
    return this.source;
  }

  /** Test seam for installing a stub source. */
  setCandleSource(source: CandleSource | null): void {
    this.source = source;
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
   * Historical candles for a token.
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
   * They now come from a `CandleSource`: either `PoolCandle`, which the
   * indexer folds from swap logs it actually read, or an external OHLCV
   * endpoint. When the source has nothing, this returns nothing: an empty
   * chart is a true statement about a token nobody has traded, and an invented
   * one is not.
   */
  async getCandles(
    token: string,
    timeframe: string,
    limit = 100,
    chainId: string = DEFAULT_CHAIN_ID
  ): Promise<CandleData[]> {
    return this.read({ chainId, symbol: token }, timeframe, limit);
  }

  /**
   * The same read, addressed by contract rather than by symbol.
   *
   * The discovery route already resolved the token to a contract before asking
   * for its chart, and handing the symbol back was a round trip through a
   * lookup that can return a *different* token — same ticker, different
   * address, on a chain where both are listed. A caller holding the contract
   * should say so.
   */
  async getCandlesForContract(
    chainId: string,
    contractId: string,
    timeframe: string,
    limit = 100
  ): Promise<CandleData[]> {
    return this.read({ chainId, contractId }, timeframe, limit);
  }

  /**
   * Candles bounded by a date range rather than a count.
   *
   * Backtests need this shape: "every candle between these two dates" cannot
   * be expressed as a limit, because how many candles that is depends on how
   * much the token traded. It shares source resolution and aggregation with
   * `getCandles` so a backtest and a chart of the same window cannot disagree.
   */
  async getCandlesBetween(
    token: string,
    timeframe: string,
    startDate: Date,
    endDate: Date,
    chainId: string = DEFAULT_CHAIN_ID
  ): Promise<CandleData[]> {
    const source = this.candleSource();
    if (!this.servable(source, token, timeframe)) return [];

    const rows = await source.getCandlesBetween(
      { chainId, symbol: token },
      timeframe,
      startDate,
      endDate
    );
    if (rows.length === 0) return [];

    return source.needsAggregation ? this.aggregate(rows, timeframe) : rows;
  }

  /**
   * One cached read through the configured source.
   *
   * The cache is in Redis rather than in process for the same reason the
   * GeckoTerminal client's is: the external source's binding constraint is
   * calls per minute, and two processes each holding their own cache doubles
   * the rate against it. The TTL scales with the timeframe — a daily candle
   * that cannot have moved should not be re-fetched every sixty seconds.
   *
   * A cache miss that returns nothing is not stored. "No data" is usually a
   * token whose pool is about to be discovered, and caching the absence makes
   * an empty chart persist past the moment it stopped being true.
   */
  private async read(
    query: CandleQuery,
    timeframe: string,
    limit: number
  ): Promise<CandleData[]> {
    const source = this.candleSource();
    const subject = query.contractId ?? query.symbol ?? "";
    if (!this.servable(source, subject, timeframe)) return [];

    const cacheKey = `candles:${source.name}:${query.chainId}:${subject.toLowerCase()}:${timeframe}:${limit}`;
    const redis = RedisService.getInstance();

    const hit = await redis.get(cacheKey).catch(() => null);
    if (hit) {
      const parsed = parseCached(hit);
      if (parsed) return parsed;
    }

    const rows = await source.getCandles(query, timeframe, limit);
    if (rows.length === 0) return [];

    const candles = source.needsAggregation
      ? this.aggregate(rows, timeframe).slice(-limit)
      : rows.slice(-limit);

    await redis
      .set(cacheKey, JSON.stringify(candles), candleCacheTtlSeconds(timeframe))
      .catch(() => {});

    return candles;
  }

  /** Whether the source can answer this timeframe at all. */
  private servable(source: CandleSource, subject: string, timeframe: string): boolean {
    if (timeframeMs(timeframe) === null) return false;

    if (!source.supportsTimeframe(timeframe)) {
      logger.debug("[candles] timeframe finer than the source records", {
        subject,
        timeframe,
        source: source.name,
      });
      return false;
    }

    return true;
  }

  /**
   * Folds five-minute buckets into wider candles.
   *
   * Open is the first bucket's open and close is the last bucket's close —
   * not the extremes of the window. Taking the high as the open produces a
   * chart that looks entirely plausible and is wrong, which is the worst
   * available outcome.
   *
   * Only sources that say `needsAggregation` go through here. Folding candles
   * that are already at the requested timeframe would silently shift every
   * open, so the source declares its resolution rather than the caller
   * guessing from row spacing.
   *
   * Input must be chronological.
   */
  private aggregate(rows: CandleData[], timeframe: string): CandleData[] {
    const out: CandleData[] = [];
    let current: CandleData | null = null;
    let currentStart = -1;

    for (const row of rows) {
      const periodStart = this.getPeriodStart(row.timestamp.getTime(), timeframe).getTime();

      if (!current || periodStart !== currentStart) {
        if (current) out.push(current);
        currentStart = periodStart;
        current = {
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
          timestamp: new Date(periodStart),
        };
        continue;
      }

      current.high = Math.max(current.high, row.high);
      current.low = Math.min(current.low, row.low);
      current.close = row.close;
      current.volume += row.volume;
    }

    if (current) out.push(current);
    return out;
  }
}

/**
 * Revives a cached series.
 *
 * `timestamp` is a `Date` in the interface and JSON has no date type, so it
 * comes back as a string — and every consumer calls `.getTime()` on it.
 * A corrupt entry is discarded rather than thrown: the read behind it is
 * cheap, and a cache should never be able to fail a request.
 */
function parseCached(raw: string): CandleData[] | null {
  try {
    const parsed = JSON.parse(raw) as (Omit<CandleData, "timestamp"> & { timestamp: string })[];
    if (!Array.isArray(parsed)) return null;
    return parsed.map((c) => ({ ...c, timestamp: new Date(c.timestamp) }));
  } catch {
    return null;
  }
}
