import { RedisService } from "./redis.js";
import { logger } from "../utils/logger.js";

interface PricePoint {
  timestamp: number;
  price: number;
}

export class PriceHistoryService {
  private static instance: PriceHistoryService;
  private readonly maxPoints = 500;
  private memory: Map<string, PricePoint[]> = new Map();

  private constructor() {}

  static getInstance(): PriceHistoryService {
    if (!PriceHistoryService.instance) {
      PriceHistoryService.instance = new PriceHistoryService();
    }
    return PriceHistoryService.instance;
  }

  async record(token: string, price: number): Promise<void> {
    const key = `pricehistory:${token.toUpperCase()}`;
    const point: PricePoint = { timestamp: Date.now(), price };

    // In-memory ring buffer
    let points = this.memory.get(key) ?? [];
    points.push(point);
    if (points.length > this.maxPoints) points = points.slice(-this.maxPoints);
    this.memory.set(key, points);

    // Persist to Redis as compressed JSON (keep last 500 points)
    const redis = RedisService.getInstance();
    redis.set(key, JSON.stringify(points), 3600).catch(() => {});
  }

  /**
   * The prices actually observed for this token, oldest first.
   *
   * Returns fewer than `periods` when fewer have been recorded, and nothing at
   * all when none have. It used to invent the difference: on a cold start it
   * generated a hundred points of random walk from the current spot price and
   * persisted them to Redis, so the fabrication outlived the process. Every
   * indicator below is computed from this series, and those indicators size
   * real trades — so an empty series has to read as empty.
   */
  async getHistory(token: string, periods: number): Promise<number[]> {
    const key = `pricehistory:${token.toUpperCase()}`;
    let points = this.memory.get(key);

    // Fall back to Redis
    if (!points) {
      const redis = RedisService.getInstance();
      const cached = await redis.get(key);
      if (cached) {
        try {
          points = JSON.parse(cached);
          this.memory.set(key, points!);
        } catch {
          logger.warn("[priceHistory] discarding unparseable cached series", { token });
        }
      }
    }

    if (!points || points.length === 0) return [];

    return points.slice(-periods).map((p) => p.price);
  }

  /**
   * Standard deviation of period-over-period returns, or null.
   *
   * Every indicator here returns `number | null`, and the null is the point.
   * Each used to return 0 when it had no data, but 0 is a measurement in all
   * five: a flat price genuinely has zero volatility and zero momentum, and an
   * average of zero is a token that costs nothing. Collapsing "no data" onto
   * one of those made the two indistinguishable at every call site.
   *
   * It was not hypothetical. RotationalStrategy ranked tokens by momentum and
   * bought the top K; a token with no history scored 0 and therefore outranked
   * every token with genuinely negative momentum, so the strategy
   * preferentially bought what it knew nothing about in exactly the market
   * where that is most expensive.
   */
  async computeVolatility(token: string, periods: number): Promise<number | null> {
    const prices = await this.getHistory(token, periods);
    if (prices.length < 2) return null;

    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i]! - prices[i - 1]!) / prices[i - 1]!);
    }

    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
  }

  /** Percent change across the window, or null if there is nothing to compare. */
  async computeMomentum(token: string, lookback: number): Promise<number | null> {
    const prices = await this.getHistory(token, lookback);
    if (prices.length < 2) return null;
    const first = prices[0]!;
    const last = prices[prices.length - 1]!;
    return ((last - first) / first) * 100;
  }

  async computeMovingAverage(token: string, periods: number): Promise<number | null> {
    const prices = await this.getHistory(token, periods);
    if (prices.length === 0) return null;
    return prices.reduce((s, p) => s + p, 0) / prices.length;
  }

  async computeHigh(token: string, periods: number): Promise<number | null> {
    const prices = await this.getHistory(token, periods);
    if (prices.length === 0) return null;
    return Math.max(...prices);
  }

  async computeLow(token: string, periods: number): Promise<number | null> {
    const prices = await this.getHistory(token, periods);
    if (prices.length === 0) return null;
    return Math.min(...prices);
  }
}
