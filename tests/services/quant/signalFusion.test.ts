import { describe, it, expect } from "vitest";
import { SignalFusionService } from "../../../src/services/quant/signalFusion.js";
import type { Features } from "../../../src/services/quant/featureEngine.js";

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

describe("SignalFusionService", () => {
  const service = SignalFusionService.getInstance();

  it("returns HOLD when features are neutral", () => {
    const features = makeFeatures();
    const forecast = service.fuse(1, "STX", features);

    expect(forecast.direction).toBe("HOLD");
    expect(forecast.confidence).toBe(0);
  });

  it("returns BUY with positive confidence when trend indicators are bullish", () => {
    const features = makeFeatures({
      macdHistogram: 0.05,
      ema12: 2.2,
      ema26: 2.0,
      return1h: 0.02,
      return4h: 0.03,
      return24h: 0.05,
    });
    const forecast = service.fuse(1, "STX", features);

    expect(forecast.direction).toBe("BUY");
    expect(forecast.confidence).toBeGreaterThan(0);
    expect(forecast.rationale).toContain("MACD histogram bullish (above signal line)");
  });

  it("returns SELL with positive confidence when trend indicators are bearish", () => {
    const features = makeFeatures({
      macdHistogram: -0.05,
      ema12: 1.8,
      ema26: 2.0,
      return1h: -0.02,
      return4h: -0.03,
      return24h: -0.05,
    });
    const forecast = service.fuse(1, "STX", features);

    expect(forecast.direction).toBe("SELL");
    expect(forecast.confidence).toBeGreaterThan(0);
  });

  it("fuses mean reversion buy signals when RSI is oversold", () => {
    const features = makeFeatures({
      rsi14: 25,
      vwapDistance: -0.06,
    });
    const forecast = service.fuse(1, "STX", features);

    expect(forecast.direction).toBe("BUY");
    expect(forecast.rationale).toContain("RSI is oversold (25.0)");
  });
});
