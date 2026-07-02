import type { Features } from "./featureEngine.js";
import type { SignalForecast } from "../../types/market.js";
import { logger } from "../../utils/logger.js";

export class SignalFusionService {
  private static instance: SignalFusionService;

  private constructor() {}

  static getInstance(): SignalFusionService {
    if (!SignalFusionService.instance) {
      SignalFusionService.instance = new SignalFusionService();
    }
    return SignalFusionService.instance;
  }

  /**
   * Fuses multiple technical and statistical features into a single consensus SignalForecast.
   */
  fuse(strategyId: number, token: string, features: Features): SignalForecast {
    const rationale: string[] = [];
    let trendScore = 0; // -50 to +50
    let reversionScore = 0; // -50 to +50

    // 1. Trend/Momentum Sub-system
    // MACD Histogram consensus
    if (features.macdHistogram > 0) {
      trendScore += 15;
      rationale.push("MACD histogram bullish (above signal line)");
    } else if (features.macdHistogram < 0) {
      trendScore -= 15;
      rationale.push("MACD histogram bearish (below signal line)");
    }

    // Moving average alignment (EMA12 vs EMA26)
    if (features.ema12 > features.ema26) {
      trendScore += 15;
      rationale.push("Short-term EMA (12) above medium-term EMA (26)");
    } else {
      trendScore -= 15;
      rationale.push("Short-term EMA (12) below medium-term EMA (26)");
    }

    // Multi-timeframe returns
    const avgReturn = (features.return1h + features.return4h + features.return24h) / 3;
    if (avgReturn > 0.01) {
      trendScore += 20;
      rationale.push(`Positive rolling returns (avg: ${(avgReturn * 100).toFixed(1)}%)`);
    } else if (avgReturn < -0.01) {
      trendScore -= 20;
      rationale.push(`Negative rolling returns (avg: ${(avgReturn * 100).toFixed(1)}%)`);
    }

    // 2. Mean Reversion Sub-system
    // RSI oversold/overbought boundaries
    if (features.rsi14 < 30) {
      reversionScore += 35;
      rationale.push(`RSI is oversold (${features.rsi14.toFixed(1)})`);
    } else if (features.rsi14 > 70) {
      reversionScore -= 35;
      rationale.push(`RSI is overbought (${features.rsi14.toFixed(1)})`);
    }

    // VWAP distance mean reversion
    if (features.vwapDistance < -0.05) {
      reversionScore += 15;
      rationale.push(`Price is ${(Math.abs(features.vwapDistance) * 100).toFixed(1)}% below VWAP (oversold deviation)`);
    } else if (features.vwapDistance > 0.05) {
      reversionScore -= 15;
      rationale.push(`Price is ${(features.vwapDistance * 100).toFixed(1)}% above VWAP (overbought deviation)`);
    }

    // 3. Final Fusion & Confidence
    const totalScore = trendScore + reversionScore;
    let direction: "BUY" | "SELL" | "HOLD" = "HOLD";
    let confidence = 0;

    // Normalise confidence based on score strength
    if (totalScore > 25) {
      direction = "BUY";
      confidence = Math.min(1.0, Math.abs(totalScore) / 100);
    } else if (totalScore < -25) {
      direction = "SELL";
      confidence = Math.min(1.0, Math.abs(totalScore) / 100);
    }

    // Estimate expected return & risk based on ATR and Volatility
    // Expected risk = 3 * ATR (expressed as % of current price)
    const expectedRisk = features.currentPrice > 0
      ? Math.min(0.25, (3 * features.atr) / features.currentPrice)
      : 0.10;

    // Expected return = risk * reward-to-risk ratio (default 2:1)
    const expectedReturn = expectedRisk * 2;

    return {
      strategyId,
      token,
      direction,
      confidence,
      expectedReturn,
      expectedRisk,
      rationale,
    };
  }
}
