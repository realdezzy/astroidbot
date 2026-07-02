import { describe, it, expect } from "vitest";
import { PortfolioOptimizer } from "../../../src/services/quant/portfolioOptimizer.js";
import type { Features } from "../../../src/services/quant/featureEngine.js";
import type { SignalForecast } from "../../../src/types/market.js";

function makeFeatures(overrides: Partial<Features> = {}): Features {
  return {
    currentPrice: 2.0,
    return1h: 0,
    return4h: 0,
    return24h: 0,
    return7d: 0,
    rsi14: 50,
    macdHistogram: 0,
    vwapDistance: 0,
    sma20: 2.0,
    ema12: 2.0,
    ema26: 2.0,
    historicalVolatility: 0.3,
    atr: 0.05,
    bollingerWidth: 0.02,
    ...overrides,
  };
}

function makeForecast(overrides: Partial<SignalForecast> = {}): SignalForecast {
  return {
    strategyId: 1,
    token: "STX",
    direction: "BUY",
    confidence: 0.8,
    expectedReturn: 0.2,
    expectedRisk: 0.1,
    rationale: ["Bullish"],
    ...overrides,
  };
}

describe("PortfolioOptimizer", () => {
  const optimizer = PortfolioOptimizer.getInstance();

  it("returns baseAmountIn for SELL actions without modification", () => {
    const features = makeFeatures();
    const forecast = makeForecast({ direction: "SELL" });
    const size = optimizer.optimizeSizing("SELL", 100, features, forecast, 1000, 10);
    expect(size).toBe(100);
  });

  it("reduces size when asset volatility is higher than target", () => {
    const baseSize = 100;
    const lowVolFeatures = makeFeatures({ historicalVolatility: 0.15 });
    const highVolFeatures = makeFeatures({ historicalVolatility: 0.60 });
    const forecast = makeForecast();

    const lowVolSize = optimizer.optimizeSizing("BUY", baseSize, lowVolFeatures, forecast, 1000, 10);
    const highVolSize = optimizer.optimizeSizing("BUY", baseSize, highVolFeatures, forecast, 1000, 10);

    expect(highVolSize).toBeLessThan(lowVolSize);
  });

  it("clamps size to maxPositionPct constraint", () => {
    const features = makeFeatures({ currentPrice: 2.0 }); // USD price = $2.0
    const forecast = makeForecast();
    // Wallet value = $1000. Max position limit = 10% ($100 max position).
    // Price = $2.0, so max allowed position in units is 50.
    const size = optimizer.optimizeSizing("BUY", 200, features, forecast, 1000, 10);
    expect(size).toBeLessThanOrEqual(50);
  });
});
