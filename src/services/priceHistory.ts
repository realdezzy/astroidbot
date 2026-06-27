import { RedisService } from "./redis.js";
import { ConfigManager } from "../config.js";
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
        } catch {}
      }
    }

    if (!points || points.length === 0) return [];

    return points.slice(-periods).map((p) => p.price);
  }

  async computeVolatility(token: string, periods: number): Promise<number> {
    const prices = await this.getHistory(token, periods);
    if (prices.length < 2) return 0;

    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i]! - prices[i - 1]!) / prices[i - 1]!);
    }

    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
  }

  async computeMomentum(token: string, lookback: number): Promise<number> {
    const prices = await this.getHistory(token, lookback);
    if (prices.length < 2) return 0;
    const first = prices[0]!;
    const last = prices[prices.length - 1]!;
    return ((last - first) / first) * 100;
  }

  async computeMovingAverage(token: string, periods: number): Promise<number> {
    const prices = await this.getHistory(token, periods);
    if (prices.length === 0) return 0;
    return prices.reduce((s, p) => s + p, 0) / prices.length;
  }

  async computeHigh(token: string, periods: number): Promise<number> {
    const prices = await this.getHistory(token, periods);
    if (prices.length === 0) return 0;
    return Math.max(...prices);
  }

  async computeLow(token: string, periods: number): Promise<number> {
    const prices = await this.getHistory(token, periods);
    if (prices.length === 0) return 0;
    return Math.min(...prices);
  }
}
