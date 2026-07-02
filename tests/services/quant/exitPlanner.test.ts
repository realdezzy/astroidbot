import { describe, it, expect } from "vitest";
import { ExitPlanner } from "../../../src/services/quant/exitPlanner.js";
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

describe("ExitPlanner", () => {
  const exitPlanner = ExitPlanner.getInstance();

  it("returns no exit when price is within normal variance range", () => {
    const features = makeFeatures({ atr: 0.1 });
    // WAC entry: 2.0, Current: 1.9. ATR stop level is 2.0 - 3*0.1 = 1.7. Period high is 2.0.
    const result = exitPlanner.computeAdaptiveStop("STX", 2.0, 1.9, 2.0, features);
    expect(result.shouldExit).toBe(false);
  });

  it("triggers ATR stop when price falls below volatility boundary", () => {
    const features = makeFeatures({ atr: 0.1 });
    // WAC entry: 2.0, Current: 1.65. ATR stop level is 1.7.
    const result = exitPlanner.computeAdaptiveStop("STX", 2.0, 1.65, 2.0, features);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toContain("Volatility stop");
  });

  it("triggers Chandelier exit when price drops significantly from high-water mark", () => {
    const features = makeFeatures({ atr: 0.1 });
    // Entry: 2.0, High: 2.5, Current: 2.15. Chandelier stop level is 2.5 - 3*0.1 = 2.2.
    const result = exitPlanner.computeAdaptiveStop("STX", 2.0, 2.15, 2.5, features);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toContain("Chandelier exit");
  });
});
