import { DatabaseService } from "../db.js";
import { logger } from "../../utils/logger.js";

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
    const m = date.getMinutes();
    const h = date.getHours();

    switch (timeframe) {
      case "1m":
        date.setSeconds(0, 0);
        break;
      case "5m":
        date.setMinutes(m - (m % 5), 0, 0);
        break;
      case "15m":
        date.setMinutes(m - (m % 15), 0, 0);
        break;
      case "1h":
        date.setMinutes(0, 0, 0);
        break;
      case "4h":
        date.setHours(h - (h % 4), 0, 0, 0);
        break;
      case "1d":
        date.setHours(0, 0, 0, 0);
        break;
      default:
        date.setSeconds(0, 0);
    }
    return date;
  }

  /**
   * Records a new swap/price tick and updates candles across all timeframes.
   */
  async recordPrice(token: string, price: number, volume: number): Promise<void> {
    if (price <= 0) return;
    const db = DatabaseService.getInstance();
    const cleanToken = token.toUpperCase();
    const now = Date.now();
    const timeframes = ["1m", "5m", "15m", "1h", "4h", "1d"];

    await Promise.all(
      timeframes.map(async (tf) => {
        try {
          const periodStart = this.getPeriodStart(now, tf);
          
          // Upsert logic inside database using prisma
          await db.prisma.$transaction(async (tx) => {
            const existing = await tx.candle.findFirst({
              where: {
                token: cleanToken,
                timeframe: tf,
                timestamp: periodStart,
              },
            });

            if (existing) {
              await tx.candle.update({
                where: { id: existing.id },
                data: {
                  high: Math.max(existing.high, price),
                  low: Math.min(existing.low, price),
                  close: price,
                  volume: existing.volume + volume,
                },
              });
            } else {
              await tx.candle.create({
                data: {
                  token: cleanToken,
                  timeframe: tf,
                  timestamp: periodStart,
                  open: price,
                  high: price,
                  low: price,
                  close: price,
                  volume,
                },
              });
            }
          });
        } catch (e) {
          logger.warn("Failed to update candle period", { token, timeframe: tf, error: e });
        }
      })
    );
  }

  /**
   * Retrieves historical candles for a token/timeframe.
   */
  async getCandles(token: string, timeframe: string, limit = 100): Promise<CandleData[]> {
    const db = DatabaseService.getInstance();
    const cleanToken = token.toUpperCase();

    let candles = await db.prisma.candle.findMany({
      where: {
        token: cleanToken,
        timeframe,
      },
      orderBy: {
        timestamp: "desc",
      },
      take: limit,
    });

    // Auto-seed to prevent cold-start data gaps
    if (candles.length === 0) {
      try {
        const seeded = await this.autoSeed(cleanToken, timeframe, limit);
        return seeded;
      } catch (err) {
        logger.warn("Candle auto-seeding failed", { token, error: err });
      }
    }

    // Return in chronological order
    return candles.reverse().map((c) => ({
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      timestamp: c.timestamp,
    }));
  }

  /**
   * Seeds historical candles for testing/cold start
   */
  private async autoSeed(token: string, timeframe: string, limit: number): Promise<CandleData[]> {
    const db = DatabaseService.getInstance();
    const registryModule = await import("../dex/dexRegistry.js");
    const registry = registryModule.DEXRegistry.getInstance();
    const currentPrice = await registry.getTokenPrice(token).catch(() => 1.0);
    const startPrice = currentPrice > 0 ? currentPrice : 1.0;

    const intervalMsMap: Record<string, number> = {
      "1m": 60_000,
      "5m": 300_000,
      "15m": 900_000,
      "1h": 3600_000,
      "4h": 14400_000,
      "1d": 86400_000,
    };
    const intervalMs = intervalMsMap[timeframe] ?? 60_000;
    const now = Date.now();
    const candlesToCreate: any[] = [];
    let lastPrice = startPrice;

    for (let i = limit; i >= 1; i--) {
      const periodStart = this.getPeriodStart(now - i * intervalMs, timeframe);
      const volatility = 0.005; // 0.5% period volatility
      const change = 1 + (Math.random() - 0.5) * volatility;
      const open = lastPrice;
      const close = lastPrice * change;
      const high = Math.max(open, close) * (1 + Math.random() * 0.002);
      const low = Math.min(open, close) * (1 - Math.random() * 0.002);
      const volume = 1000 + Math.random() * 10000;

      candlesToCreate.push({
        token,
        timeframe,
        timestamp: periodStart,
        open,
        high,
        low,
        close,
        volume,
      });

      lastPrice = close;
    }

    try {
      // Ignore conflicts if other worker or test already seeded
      await db.prisma.candle.createMany({
        data: candlesToCreate,
        skipDuplicates: true,
      });
    } catch {}

    const candles = await db.prisma.candle.findMany({
      where: { token, timeframe },
      orderBy: { timestamp: "desc" },
      take: limit,
    });

    return candles.reverse().map((c) => ({
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      timestamp: c.timestamp,
    }));
  }
}
