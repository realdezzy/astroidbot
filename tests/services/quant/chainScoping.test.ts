import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadTestConfig } from "../../helpers/config.js";

/**
 * The quant layer read every token's candles with no chain, which defaulted
 * to Stacks. A Base token therefore had no history, so its features came back
 * unavailable, its regime UNKNOWN — and the regime gate, which omits UNKNOWN
 * for grid, breakout, momentum and mean reversion, suppressed all four on
 * every non-Stacks wallet. The market context was also one global cache slot,
 * so whichever chain built it first supplied it to every wallet that cycle.
 */

const getCandles = vi.hoisted(() => vi.fn());
const getTokenPrice = vi.hoisted(() => vi.fn());
const getBestQuote = vi.hoisted(() => vi.fn());

vi.mock("../../../src/services/quant/candleService.js", () => ({
  CandleService: { getInstance: () => ({ getCandles }) },
}));
vi.mock("../../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: { getInstance: () => ({ getTokenPrice, getBestQuote }) },
}));
vi.mock("../../../src/services/redis.js", () => ({
  RedisService: { getInstance: () => ({ get: async () => null, set: async () => undefined }) },
}));

const { FeatureEngine } = await import("../../../src/services/quant/featureEngine.js");
const { RegimeDetectionService } = await import("../../../src/services/quant/regimeDetection.js");
const { MarketDataService } = await import("../../../src/services/quant/marketData.js");

/** 300 five-minute candles rising 0.5% each — a clear bull trend. */
const trending = Array.from({ length: 300 }, (_, i) => {
  const p = 100 * 1.005 ** i;
  return { open: p, high: p, low: p, close: p, volume: 1, timestamp: new Date() };
});

describe("quant layer chain scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadTestConfig({ QUANT_ENABLED: "true" });
    getTokenPrice.mockResolvedValue(1);
    getBestQuote.mockResolvedValue(null);
    // Fresh caches: both services are singletons.
    (RegimeDetectionService.getInstance() as unknown as { cache: Map<string, unknown> }).cache.clear();
    (MarketDataService.getInstance() as unknown as { contextCache: Map<string, unknown> }).contextCache.clear();
  });

  it("reads candles and price on the requested chain", async () => {
    getCandles.mockResolvedValue([]);
    await FeatureEngine.getInstance().compute("AERO", "base:mainnet");

    expect(getCandles).toHaveBeenCalledWith("AERO", "5m", 200, "base:mainnet");
    expect(getTokenPrice).toHaveBeenCalledWith("AERO", "base:mainnet");
  });

  it("classifies a Base token from Base candles instead of reporting UNKNOWN", async () => {
    getCandles.mockImplementation(async (_t: string, _tf: string, _n: number, chainId: string) =>
      chainId === "base:mainnet" ? trending : []
    );

    const regime = await RegimeDetectionService.getInstance().detectRegime("AERO", "base:mainnet");
    expect(regime).toBe("TRENDING_BULL");
  });

  it("caches regimes per chain, so one chain's reading never answers for another", async () => {
    getCandles.mockImplementation(async (_t: string, _tf: string, _n: number, chainId: string) =>
      chainId === "base:mainnet" ? trending : []
    );
    const regimes = RegimeDetectionService.getInstance();

    expect(await regimes.detectRegime("ETH", "base:mainnet")).toBe("TRENDING_BULL");
    expect(await regimes.detectRegime("ETH", "robinhood:mainnet")).toBe("UNKNOWN");
  });

  it("builds and caches a market context per chain", async () => {
    getCandles.mockResolvedValue(trending);
    const market = MarketDataService.getInstance();

    const base = await market.getContext(["AERO"], "base:mainnet");
    const stacks = await market.getContext(["ALEX"], "stacks:mainnet");

    expect([...base.snapshots.keys()]).toEqual(["AERO"]);
    expect([...stacks.snapshots.keys()]).toEqual(["ALEX"]);
    // Depth is probed with the chain's own native asset on its own DEXs.
    expect(getBestQuote).toHaveBeenCalledWith("ETH", "AERO", 100, "base:mainnet");
    expect(getBestQuote).toHaveBeenCalledWith("STX", "ALEX", 100, "stacks:mainnet");
  });
});
