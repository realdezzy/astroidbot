import type { SignalForecast } from "../../types/market.js";
import type { Features } from "./featureEngine.js";
import { logger } from "../../utils/logger.js";

export class PortfolioOptimizer {
  private static instance: PortfolioOptimizer;
  // Default target annualised volatility (e.g., 30%).
  private readonly targetVolatility = 0.30;
  // Conservative Kelly fraction to prevent over-allocation.
  private readonly kellyFraction = 0.20;

  private constructor() {}

  static getInstance(): PortfolioOptimizer {
    if (!PortfolioOptimizer.instance) {
      PortfolioOptimizer.instance = new PortfolioOptimizer();
    }
    return PortfolioOptimizer.instance;
  }

  /**
   * Scales a proposed trade size using Kelly Criterion and Volatility Targeting (Risk Parity).
   */
  optimizeSizing(
    direction: "BUY" | "SELL",
    baseAmountIn: number,
    features: Features,
    forecast: SignalForecast,
    walletBalanceUsd: number,
    maxPositionPct: number
  ): number {
    if (direction === "SELL") {
      // For sell actions (liquidations/stops), always execute full requested amount to cut risk.
      return baseAmountIn;
    }

    try {
      // 1. Kelly Sizing Multiplier
      // Kelly % = win_prob - (1 - win_prob) / win_loss_ratio
      // We proxy win_prob with forecast.confidence.
      // Win/loss ratio (reward-to-risk) is expectedReturn / expectedRisk.
      const winProb = forecast.confidence;
      const winLossRatio = forecast.expectedRisk > 0
        ? forecast.expectedReturn / forecast.expectedRisk
        : 2.0;

      const rawKelly = winLossRatio > 0
        ? winProb - (1 - winProb) / winLossRatio
        : 0;

      // Scale by conservative fractional Kelly factor
      const kellyScale = Math.max(0.1, Math.min(1.5, rawKelly * this.kellyFraction));

      // 2. Volatility Targeting Scale Factor (Risk Parity)
      // High volatility -> smaller position size.
      const currentVol = features.historicalVolatility;
      let volScale = 1.0;
      if (currentVol > 0) {
        volScale = this.targetVolatility / currentVol;
        // Clamp scale to avoid extreme sizing swings
        volScale = Math.max(0.2, Math.min(1.5, volScale));
      }

      // 3. Combine scale factors
      const combinedScale = kellyScale * volScale;
      let optimizedAmount = baseAmountIn * combinedScale;

      // 4. Portfolio Capping Constraints
      // Ensure the trade does not exceed the user's maxPositionPct setting.
      if (walletBalanceUsd > 0 && features.currentPrice > 0) {
        const maxTradeValueUsd = walletBalanceUsd * (maxPositionPct / 100);
        // Note: baseAmountIn is in STX or the input token.
        // We approximate the USD value of the trade. If input is STX, we use current STX price (proportional).
        // Let's assume input is STX or equivalent, so we clamp the USD value.
        // For simplicity: convert optimizedAmount to USD.
        // If we are swapping STX (price ~$1.5-3.0), we scale maxTradeValueUsd to token units.
        const maxTradeUnits = maxTradeValueUsd / (features.currentPrice || 1.5);
        if (optimizedAmount > maxTradeUnits) {
          optimizedAmount = maxTradeUnits;
        }
      }

      // Safeguard: Never return less than 5% of baseAmount to avoid dust/failed swaps.
      return Math.max(baseAmountIn * 0.05, optimizedAmount);
    } catch (err) {
      logger.warn("[PortfolioOptimizer] Optimization failed — falling back to base amount", { error: err });
      return baseAmountIn;
    }
  }
}
