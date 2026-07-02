import { DatabaseService } from "../db.js";
import { logger } from "../../utils/logger.js";

export class PoolStatsService {
  private static instance: PoolStatsService;

  private constructor() {}

  static getInstance(): PoolStatsService {
    if (!PoolStatsService.instance) {
      PoolStatsService.instance = new PoolStatsService();
    }
    return PoolStatsService.instance;
  }

  /**
   * Persists a pool statistics snapshot to the database.
   */
  async recordPoolStats(
    token: string,
    stats: {
      liquidityUsd: number;
      tvlUsd: number;
      volume24hUsd: number;
      holderConcentration: number;
      netWhaleFlowUsd: number;
    }
  ): Promise<void> {
    const db = DatabaseService.getInstance();
    const cleanToken = token.toUpperCase();

    try {
      await db.prisma.poolStatsHistory.create({
        data: {
          token: cleanToken,
          liquidityUsd: stats.liquidityUsd,
          tvlUsd: stats.tvlUsd,
          volume24hUsd: stats.volume24hUsd,
          holderConcentration: stats.holderConcentration,
          netWhaleFlowUsd: stats.netWhaleFlowUsd,
        },
      });
    } catch (e) {
      logger.warn("Failed to record pool stats history", { token, error: e });
    }
  }

  /**
   * Detects if liquidity is draining by comparing today's liquidity with the average of the last 7 days.
   */
  async isLiquidityDraining(token: string): Promise<boolean> {
    const db = DatabaseService.getInstance();
    const cleanToken = token.toUpperCase();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const stats = await db.prisma.poolStatsHistory.findMany({
      where: {
        token: cleanToken,
        timestamp: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { timestamp: "desc" },
    });

    if (stats.length < 3) return false; // Not enough history to judge

    const currentStats = stats.filter((s) => s.timestamp >= oneDayAgo);
    const historicalStats = stats.filter((s) => s.timestamp < oneDayAgo);

    if (currentStats.length === 0 || historicalStats.length === 0) return false;

    const avgCurrent = currentStats.reduce((s, x) => s + x.liquidityUsd, 0) / currentStats.length;
    const avgHistorical = historicalStats.reduce((s, x) => s + x.liquidityUsd, 0) / historicalStats.length;

    // Trigger warning if current liquidity is more than 20% lower than historical average
    return avgCurrent < avgHistorical * 0.8;
  }

  /**
   * Evaluates volume spike ratio (recent 4h vs last 48h).
   */
  async getVolumeTrend(token: string): Promise<{ spike: boolean; ratio: number }> {
    const db = DatabaseService.getInstance();
    const cleanToken = token.toUpperCase();
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);

    const stats = await db.prisma.poolStatsHistory.findMany({
      where: {
        token: cleanToken,
        timestamp: { gte: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) }, // 48h lookback
      },
    });

    if (stats.length < 4) return { spike: false, ratio: 1.0 };

    const recent = stats.filter((s) => s.timestamp >= fourHoursAgo);
    const historical = stats.filter((s) => s.timestamp < fourHoursAgo);

    if (recent.length === 0 || historical.length === 0) {
      return { spike: false, ratio: 1.0 };
    }

    const avgRecentVolume = recent.reduce((s, x) => s + x.volume24hUsd, 0) / recent.length;
    const avgHistoricalVolume = historical.reduce((s, x) => s + x.volume24hUsd, 0) / historical.length;

    if (avgHistoricalVolume <= 0) return { spike: false, ratio: 1.0 };

    const ratio = avgRecentVolume / avgHistoricalVolume;
    return {
      spike: ratio > 2.0, // True if volume is double the historical baseline
      ratio,
    };
  }
}
