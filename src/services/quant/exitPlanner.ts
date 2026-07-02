import type { Features } from "./featureEngine.js";
import { logger } from "../../utils/logger.js";

export interface ExitPlanResult {
  shouldExit: boolean;
  reason: string;
}

export class ExitPlanner {
  private static instance: ExitPlanner;
  // Default multiplier for Average True Range stops.
  private readonly atrMultiplier = 3.0;

  private constructor() {}

  static getInstance(): ExitPlanner {
    if (!ExitPlanner.instance) {
      ExitPlanner.instance = new ExitPlanner();
    }
    return ExitPlanner.instance;
  }

  /**
   * Computes volatility-adjusted adaptive exits (ATR Stop and Chandelier Exit).
   */
  computeAdaptiveStop(
    token: string,
    entryPrice: number,
    currentPrice: number,
    periodHigh: number,
    features: Features
  ): ExitPlanResult {
    if (entryPrice <= 0 || currentPrice <= 0) {
      return { shouldExit: false, reason: "Invalid prices" };
    }

    const atr = features.atr;
    if (atr <= 0) {
      return { shouldExit: false, reason: "No volatility data" };
    }

    // 1. Volatility-adjusted ATR Stop (Hard stop)
    // Dynamic stop level is wider in high-volatility environments.
    const atrStopLevel = entryPrice - this.atrMultiplier * atr;
    if (currentPrice <= atrStopLevel) {
      const dropPct = ((currentPrice - entryPrice) / entryPrice) * 100;
      return {
        shouldExit: true,
        reason: `Volatility stop: ${token} at $${currentPrice.toFixed(4)} crossed ATR stop level $${atrStopLevel.toFixed(4)} (${dropPct.toFixed(1)}% change)`,
      };
    }

    // 2. Chandelier Exit (Trailing profit lock)
    // Trailing stop rises with the period high.
    if (periodHigh > entryPrice) {
      const chandelierStopLevel = periodHigh - this.atrMultiplier * atr;
      if (currentPrice <= chandelierStopLevel) {
        const drawdownFromHigh = ((currentPrice - periodHigh) / periodHigh) * 100;
        return {
          shouldExit: true,
          reason: `Chandelier exit: ${token} dropped $${Math.abs(currentPrice - periodHigh).toFixed(4)} (${drawdownFromHigh.toFixed(1)}%) from high of $${periodHigh.toFixed(4)}`,
        };
      }
    }

    return { shouldExit: false, reason: "Position within normal variance" };
  }
}
