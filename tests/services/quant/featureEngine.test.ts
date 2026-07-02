import { describe, it, expect, vi, beforeEach } from "vitest";
import { FeatureEngine } from "../../../src/services/quant/featureEngine.js";

const mockGetHistory = vi.fn();
const mockGetTokenPrice = vi.fn();

vi.mock("../../../src/services/priceHistory.js", () => ({
  PriceHistoryService: {
    getInstance: () => ({ getHistory: mockGetHistory }),
  },
}));

vi.mock("../../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: {
    getInstance: () => ({ getTokenPrice: mockGetTokenPrice }),
  },
}));

// Generate a smooth linear price series of N points.
function linearPrices(n: number, start = 1.0, step = 0.01): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

describe("FeatureEngine", () => {
  const engine = FeatureEngine.getInstance();

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetTokenPrice.mockResolvedValue(2.0);
  });

  it("returns zero-confidence empty features when no history exists", async () => {
    mockGetHistory.mockResolvedValue([]);
    const features = await engine.compute("STX");
    expect(features.currentPrice).toBe(2.0);
    expect(features.return1h).toBe(0);
    expect(features.rsi14).toBe(50);
    expect(features.historicalVolatility).toBe(0);
  });

  it("computes positive return1h when price trended up over last 60 periods", async () => {
    const prices = linearPrices(300, 1.0, 0.01); // price rises from 1.0 to 4.0
    mockGetHistory.mockResolvedValue(prices);
    const features = await engine.compute("STX");
    expect(features.return1h).toBeGreaterThan(0);
  });

  it("computes RSI above 50 in an uptrend", async () => {
    const prices = linearPrices(50, 1.0, 0.01);
    mockGetHistory.mockResolvedValue(prices);
    const features = await engine.compute("STX");
    expect(features.rsi14).toBeGreaterThan(50);
  });

  it("computes RSI below 50 in a downtrend", async () => {
    const prices = linearPrices(50, 2.0, -0.01);
    mockGetHistory.mockResolvedValue(prices);
    const features = await engine.compute("STX");
    expect(features.rsi14).toBeLessThan(50);
  });

  it("computes positive ATR on a volatile series", async () => {
    const prices = [1.0, 1.1, 0.9, 1.2, 0.85, 1.3, 0.8];
    mockGetHistory.mockResolvedValue(prices);
    const features = await engine.compute("STX");
    expect(features.atr).toBeGreaterThan(0);
  });

  it("computes non-zero Bollinger width when prices deviate", async () => {
    const prices = [1.0, 1.5, 0.5, 2.0, 0.3, 1.8, 0.7, 1.9, 0.4, 2.1, 0.6, 1.7, 0.8, 1.6, 0.9, 1.4, 1.0, 1.3, 1.1, 1.2];
    mockGetHistory.mockResolvedValue(prices);
    const features = await engine.compute("STX");
    expect(features.bollingerWidth).toBeGreaterThan(0);
  });

  it("returns emptyFeatures when getTokenPrice returns 0", async () => {
    mockGetTokenPrice.mockResolvedValue(0);
    mockGetHistory.mockResolvedValue([]);
    const features = await engine.compute("UNKNOWN");
    expect(features.currentPrice).toBe(0);
    expect(features.return24h).toBe(0);
  });
});
