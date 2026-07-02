import { describe, it, expect, vi, beforeEach } from "vitest";
import { RegimeDetectionService, STRATEGY_REGIME_GATES } from "../../../src/services/quant/regimeDetection.js";

const mockCompute = vi.fn();

vi.mock("../../../src/services/quant/featureEngine.js", () => ({
  FeatureEngine: {
    getInstance: () => ({ compute: mockCompute }),
  },
}));

function makeFeatures(overrides: Partial<{
  return24h: number; return7d: number; rsi14: number;
  historicalVolatility: number; bollingerWidth: number; currentPrice: number;
}> = {}) {
  return {
    currentPrice: 2.0,
    return1h: 0, return4h: 0, return24h: 0, return7d: 0,
    rsi14: 50, macdHistogram: 0, vwapDistance: 0,
    sma20: 2.0, ema12: 2.0, ema26: 2.0,
    historicalVolatility: 0.3, atr: 0.05, bollingerWidth: 0.02,
    ...overrides,
  };
}

describe("RegimeDetectionService", () => {
  let service: RegimeDetectionService;

  beforeEach(() => {
    vi.resetAllMocks();
    // Reset the singleton's cache between tests.
    (RegimeDetectionService as any).instance = undefined;
    service = RegimeDetectionService.getInstance();
  });

  it("detects TRENDING_BULL when 7-day return is strongly positive", async () => {
    mockCompute.mockResolvedValue(makeFeatures({ return7d: 0.15, return24h: 0.04 }));
    const regime = await service.detectRegime("STX");
    expect(regime).toBe("TRENDING_BULL");
  });

  it("detects TRENDING_BEAR when 7-day return is strongly negative", async () => {
    mockCompute.mockResolvedValue(makeFeatures({ return7d: -0.12, return24h: -0.05 }));
    const regime = await service.detectRegime("STX");
    expect(regime).toBe("TRENDING_BEAR");
  });

  it("detects CAPITULATION on extreme drop + oversold RSI + high volatility", async () => {
    mockCompute.mockResolvedValue(makeFeatures({ return24h: -0.15, rsi14: 20, historicalVolatility: 2.0 }));
    const regime = await service.detectRegime("STX");
    expect(regime).toBe("CAPITULATION");
  });

  it("detects RANGING_HIGH_VOL when not trending and Bollinger is wide", async () => {
    mockCompute.mockResolvedValue(makeFeatures({ return7d: 0.02, bollingerWidth: 0.06 }));
    const regime = await service.detectRegime("STX");
    expect(regime).toBe("RANGING_HIGH_VOL");
  });

  it("detects RANGING_LOW_VOL when not trending and Bollinger is narrow", async () => {
    mockCompute.mockResolvedValue(makeFeatures({ return7d: 0.01, bollingerWidth: 0.02 }));
    const regime = await service.detectRegime("STX");
    expect(regime).toBe("RANGING_LOW_VOL");
  });

  it("returns UNKNOWN when currentPrice is zero", async () => {
    mockCompute.mockResolvedValue(makeFeatures({ currentPrice: 0 }));
    const regime = await service.detectRegime("GHOST");
    expect(regime).toBe("UNKNOWN");
  });

  it("allows grid strategy in RANGING_LOW_VOL", async () => {
    mockCompute.mockResolvedValue(makeFeatures({ return7d: 0.01, bollingerWidth: 0.02 }));
    const allowed = await service.isStrategyAllowed("grid", "STX");
    expect(allowed).toBe(true);
  });

  it("suppresses grid strategy in TRENDING_BULL", async () => {
    mockCompute.mockResolvedValue(makeFeatures({ return7d: 0.15 }));
    const allowed = await service.isStrategyAllowed("grid", "STX");
    expect(allowed).toBe(false);
  });

  it("allows momentum strategy in TRENDING_BULL", async () => {
    mockCompute.mockResolvedValue(makeFeatures({ return7d: 0.15 }));
    const allowed = await service.isStrategyAllowed("momentum", "STX");
    expect(allowed).toBe(true);
  });

  it("suppresses momentum strategy in RANGING_LOW_VOL", async () => {
    mockCompute.mockResolvedValue(makeFeatures({ return7d: 0.01, bollingerWidth: 0.02 }));
    const allowed = await service.isStrategyAllowed("momentum", "STX");
    expect(allowed).toBe(false);
  });

  it("allows DCA in all regimes", async () => {
    const regimes = [
      makeFeatures({ return7d: 0.15 }),          // TRENDING_BULL
      makeFeatures({ return7d: -0.12 }),          // TRENDING_BEAR
      makeFeatures({ return7d: 0.02, bollingerWidth: 0.06 }), // RANGING_HIGH_VOL
      makeFeatures({ return7d: 0.01, bollingerWidth: 0.01 }), // RANGING_LOW_VOL
    ];

    for (const features of regimes) {
      mockCompute.mockResolvedValueOnce(features);
      // Reset cache between iterations.
      (service as any).cache = new Map();
      const allowed = await service.isStrategyAllowed("dca", "STX");
      expect(allowed).toBe(true);
    }
  });

  it("allows unknown strategy types in all regimes (fail-open)", async () => {
    mockCompute.mockResolvedValue(makeFeatures({ return7d: -0.12 }));
    const allowed = await service.isStrategyAllowed("custom_exotic_strategy", "STX");
    expect(allowed).toBe(true);
  });

  it("covers all strategy types in STRATEGY_REGIME_GATES", () => {
    const expectedStrategies = [
      "dca", "twap", "stopLossTp", "sniper", "copy",
      "breakout", "momentum", "meanReversion", "rotational",
      "portfolioRebalance", "grid",
    ];
    for (const st of expectedStrategies) {
      expect(STRATEGY_REGIME_GATES).toHaveProperty(st);
    }
  });
});
