import { DatabaseService } from "../../db.js";
import { RedisService } from "../../redis.js";
import { GeckoTerminalService, geckoNetworkFor, geckoTimeframe, MAX_CANDLES_PER_CALL } from "../../geckoTerminal.js";
import { logger } from "../../../utils/logger.js";
import type { CandleData, CandleQuery, CandleSource } from "./types.js";

/**
 * How long a token's chart pool is remembered.
 *
 * Which pool is deepest changes over hours, not seconds, and resolving it
 * costs a request against a budget measured per minute — so re-resolving it on
 * every chart load would spend more of the rate limit on "which pool" than on
 * the candles themselves.
 */
const POOL_CACHE_TTL_SECONDS = 3600;

/** Pages a date-bounded read may walk before giving up. */
const MAX_HISTORY_PAGES = 5;

/**
 * Candles from GeckoTerminal's OHLCV endpoint.
 *
 * The API returns `[timestamp, open, high, low, close, volumeUsd]` rows, which
 * is `CandleData` with the fields renamed — so this source does no arithmetic
 * on them at all. That is the point: the alternative was several thousand
 * lines of swap ingestion, bucket folding and reorg repair computing the same
 * six numbers.
 *
 * Candles are requested at the timeframe the caller asked for rather than
 * folded from five-minute buckets, so `needsAggregation` is false. Folding
 * already-folded candles yields a plausible chart with the wrong opens, which
 * is the worst available outcome.
 */
export class GeckoTerminalCandleSource implements CandleSource {
  readonly name = "geckoterminal";

  readonly needsAggregation = false;

  private readonly api = GeckoTerminalService.getInstance();

  /** The API serves one-minute candles, so every timeframe we offer maps. */
  supportsTimeframe(timeframe: string): boolean {
    return geckoTimeframe(timeframe) !== null;
  }

  async getCandles(
    query: CandleQuery,
    timeframe: string,
    limit: number
  ): Promise<CandleData[]> {
    const pool = await this.poolFor(query);
    if (!pool) return [];

    const rows = await this.api.ohlcv(query.chainId, pool, timeframe, limit);
    return rows.map(toCandle);
  }

  /**
   * A date-bounded read, walked backwards a page at a time.
   *
   * The endpoint is count-bounded rather than range-bounded, so a window is
   * reached by paging with `before_timestamp` until the oldest row precedes
   * `startDate`. Bounded at `MAX_HISTORY_PAGES` because this is a request
   * budget, not a database: an unbounded walk over a long backtest window
   * would exhaust a minute's allowance on one call.
   */
  async getCandlesBetween(
    query: CandleQuery,
    timeframe: string,
    startDate: Date,
    endDate: Date
  ): Promise<CandleData[]> {
    const pool = await this.poolFor(query);
    if (!pool) return [];

    const startSeconds = Math.floor(startDate.getTime() / 1000);
    const collected: CandleData[] = [];
    let before = Math.floor(endDate.getTime() / 1000);

    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const rows = await this.api.ohlcv(
        query.chainId,
        pool,
        timeframe,
        MAX_CANDLES_PER_CALL,
        before
      );
      if (rows.length === 0) break;

      collected.push(...rows.map(toCandle));

      const oldest = rows[0]!.timestampSeconds;
      if (oldest <= startSeconds) break;
      // Strictly older than the page just read, or the same page repeats
      // forever against a pool whose history begins mid-window.
      before = oldest - 1;
    }

    return collected
      .filter((c) => c.timestamp >= startDate && c.timestamp <= endDate)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * The pool whose candles describe this token: the deepest one it trades in.
   *
   * Same rule as the internal source and as `RollupService`. A token with no
   * pool the API knows about has no chart, which is a true statement about it.
   */
  private async poolFor(query: CandleQuery): Promise<string | null> {
    if (!geckoNetworkFor(query.chainId)) return null;

    const contractId = query.contractId
      ? query.contractId.toLowerCase()
      : await this.contractForSymbol(query);
    if (!contractId) return null;

    const cacheKey = `gt:chartpool:${query.chainId}:${contractId}`;
    const redis = RedisService.getInstance();

    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) return cached;

    const pools = await this.api.topPools(query.chainId, contractId);
    const deepest = pools.reduce<{ address: string; reserve: number } | null>((best, pool) => {
      if (!pool.address) return best;
      const reserve = pool.reserveUsd ?? 0;
      return !best || reserve > best.reserve ? { address: pool.address, reserve } : best;
    }, null);

    if (!deepest) {
      logger.debug("[candles] no external pool for token", {
        chainId: query.chainId,
        contractId,
      });
      return null;
    }

    await redis.set(cacheKey, deepest.address, POOL_CACHE_TTL_SECONDS).catch(() => {});
    return deepest.address;
  }

  /**
   * A symbol resolved to a contract address.
   *
   * The catalogue first because it is the listing decision — what this
   * deployment offers — and the index second for the long tail that appears in
   * no curated list. Both are scoped to the chain: USDC on Base and USDC on
   * Solana are different assets, and a chart drawn for the wrong one looks
   * entirely convincing.
   */
  private async contractForSymbol(query: CandleQuery): Promise<string | null> {
    if (!query.symbol) return null;

    const db = DatabaseService.getInstance();
    const symbol = { equals: query.symbol.toUpperCase(), mode: "insensitive" as const };

    const catalogued = await db.prisma.token
      .findFirst({
        where: { chainId: query.chainId, symbol },
        orderBy: { liquidityUsd: { sort: "desc", nulls: "last" } },
        select: { contractId: true },
      })
      .catch(() => null);
    if (catalogued) return catalogued.contractId.toLowerCase();

    const indexed = await db.prisma.indexedToken
      .findFirst({
        where: { chainId: query.chainId, symbol },
        select: { contractId: true },
      })
      .catch(() => null);

    return indexed ? indexed.contractId.toLowerCase() : null;
  }
}

function toCandle(row: {
  timestampSeconds: number;
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
    timestamp: new Date(row.timestampSeconds * 1000),
  };
}
