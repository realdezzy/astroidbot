import type { MarketRegime } from "../../types/market.js";
import type { StrategyType } from "../../../shared/types.js";
import { FeatureEngine } from "./featureEngine.js";
import { isQuantEnabled } from "./quantMode.js";
import { logger } from "../../utils/logger.js";

// Market regime determines which strategies are allowed to execute.
// Strategies that are not compatible with the current regime are suppressed.
//
// Keyed by StrategyType so a key that matches no strategy fails to compile.
// It used to be a plain string record with camelCase keys (`meanReversion`,
// `stopLossTp`, `portfolioRebalance`) while strategies are typed in snake_case,
// so those three lookups missed and fell through to "always allowed".
export const STRATEGY_REGIME_GATES: Record<StrategyType, MarketRegime[]> = {
  dca:                 ["TRENDING_BULL", "TRENDING_BEAR", "RANGING_HIGH_VOL", "RANGING_LOW_VOL", "UNKNOWN"],
  twap:                ["TRENDING_BULL", "TRENDING_BEAR", "RANGING_HIGH_VOL", "RANGING_LOW_VOL", "UNKNOWN"],
  stop_loss_tp:        ["TRENDING_BULL", "TRENDING_BEAR", "RANGING_HIGH_VOL", "RANGING_LOW_VOL", "CAPITULATION", "UNKNOWN"],
  sniper:              ["TRENDING_BULL", "RANGING_LOW_VOL", "UNKNOWN"],
  copy:                ["TRENDING_BULL", "TRENDING_BEAR", "RANGING_HIGH_VOL", "RANGING_LOW_VOL", "UNKNOWN"],
  breakout:            ["TRENDING_BULL", "TRENDING_BEAR"],
  momentum:            ["TRENDING_BULL", "TRENDING_BEAR"],
  mean_reversion:      ["RANGING_HIGH_VOL", "RANGING_LOW_VOL"],
  rotational:          ["TRENDING_BULL", "RANGING_LOW_VOL"],
  portfolio_rebalance: ["TRENDING_BULL", "TRENDING_BEAR", "RANGING_HIGH_VOL", "RANGING_LOW_VOL", "UNKNOWN"],
  grid:                ["RANGING_HIGH_VOL", "RANGING_LOW_VOL"],
};

export class RegimeDetectionService {
  private static instance: RegimeDetectionService;
  private featureEngine = FeatureEngine.getInstance();

  // Cached regime per (chain, token), with a TTL of 5 minutes.
  private cache: Map<string, { regime: MarketRegime; expiresAt: number }> = new Map();
  private readonly cacheTtlMs = 5 * 60 * 1000;

  private constructor() {}

  static getInstance(): RegimeDetectionService {
    if (!RegimeDetectionService.instance) {
      RegimeDetectionService.instance = new RegimeDetectionService();
    }
    return RegimeDetectionService.instance;
  }

  async detectRegime(token: string, chainId: string): Promise<MarketRegime> {
    const key = `${chainId}:${token}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.regime;
    }

    try {
      const features = await this.featureEngine.compute(token, chainId);

      // No data — cannot classify. `available` covers the case the price check
      // cannot see: a token we can price perfectly well but have no candle
      // history for, whose zeroed returns would classify as a calm range.
      if (!features.available || features.currentPrice === 0) {
        return this.cache_(key, "UNKNOWN");
      }

      const regime = this.classify(features);
      return this.cache_(key, regime);
    } catch (err) {
      logger.warn("[RegimeDetection] Classification failed", { token, chainId, error: err });
      return "UNKNOWN";
    }
  }

  // Returns true if the given strategy type is allowed to execute in the current token's regime.
  async isStrategyAllowed(strategyType: string, token: string, chainId: string): Promise<boolean> {
    // With the quant layer off there is no regime to gate on, and this must
    // fail *open*. Returning UNKNOWN instead would silently retire every
    // strategy whose gate omits it — grid, breakout, momentum and mean
    // reversion — which is not "stop consulting technical signals", it is
    // "stop trading", and it would look exactly like a strategy bug.
    if (!isQuantEnabled()) return true;

    const allowed = STRATEGY_REGIME_GATES[strategyType as StrategyType] as MarketRegime[] | undefined;
    // Unknown strategy types are always allowed (fail-open for custom strategies).
    if (!allowed) return true;

    const regime = await this.detectRegime(token, chainId);
    return allowed.includes(regime);
  }

  private classify(features: {
    return24h: number;
    return7d: number;
    rsi14: number;
    historicalVolatility: number;
    bollingerWidth: number;
  }): MarketRegime {
    const { return24h, return7d, rsi14, historicalVolatility, bollingerWidth } = features;

    // Capitulation: extreme negative return + oversold RSI + high volatility.
    if (return24h < -0.12 && rsi14 < 25 && historicalVolatility > 1.5) {
      return "CAPITULATION";
    }

    // Strong directional trend threshold: 7-day return > ±8%.
    const isTrending = Math.abs(return7d) > 0.08;
    const isBull = return7d > 0;

    if (isTrending && isBull) return "TRENDING_BULL";
    if (isTrending && !isBull) return "TRENDING_BEAR";

    // Range-bound: Bollinger width indicates squeeze or expansion.
    // High-vol ranging: wide bands but no trend.
    if (bollingerWidth > 0.04) return "RANGING_HIGH_VOL";
    return "RANGING_LOW_VOL";
  }

  private cache_(key: string, regime: MarketRegime): MarketRegime {
    this.cache.set(key, { regime, expiresAt: Date.now() + this.cacheTtlMs });
    return regime;
  }
}
