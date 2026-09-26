import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigManager } from "../../../src/config.js";
import { loadTestConfig } from "../../helpers/config.js";

/**
 * The quant layer, switched off.
 *
 * The danger this guards is not that the maths is wrong — it is that with no
 * candles to read, `emptyFeatures` hands every consumer a full set of neutral
 * *readings*: RSI 50, MACD 0, volatility 0, EMA12 exactly equal to EMA26.
 * Those are indistinguishable from measurements, and downstream they are
 * consumed as such: signal fusion scores the EMA equality as a bearish
 * crossover, and the regime gate classifies the result and suppresses
 * strategies on it.
 *
 * So "disabled" has to be a state you can ask about, and the deterministic
 * strategies have to keep running through it.
 */

const getCandles = vi.hoisted(() => vi.fn());
const getTokenPrice = vi.hoisted(() => vi.fn());

vi.mock("../../../src/services/quant/candleService.js", () => ({
  CandleService: { getInstance: () => ({ getCandles }) },
}));
vi.mock("../../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: { getInstance: () => ({ getTokenPrice }) },
}));

const { FeatureEngine } = await import("../../../src/services/quant/featureEngine.js");
const { SignalFusionService } = await import("../../../src/services/quant/signalFusion.js");
const { PortfolioOptimizer } = await import("../../../src/services/quant/portfolioOptimizer.js");
const { ExitPlanner } = await import("../../../src/services/quant/exitPlanner.js");
const { RegimeDetectionService } = await import("../../../src/services/quant/regimeDetection.js");
const { MarketDataService } = await import("../../../src/services/quant/marketData.js");

describe("quant layer disabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadTestConfig();
    // The regime cache and the context cache are singleton state.
    (RegimeDetectionService as unknown as { instance?: unknown }).instance = undefined;
    (MarketDataService as unknown as { instance?: unknown }).instance = undefined;
    getCandles.mockResolvedValue([]);
    getTokenPrice.mockResolvedValue(2.0);
  });

  it("is the default", () => {
    expect(ConfigManager.getInstance().config.QUANT_ENABLED).toBe(false);
  });

  it("marks features unavailable rather than returning zeroed readings", async () => {
    const features = await FeatureEngine.getInstance().compute("STX");

    expect(features.available).toBe(false);
    // And costs nothing: no candle read, no price read, per token per tick.
    expect(getCandles).not.toHaveBeenCalled();
    expect(getTokenPrice).not.toHaveBeenCalled();
  });

  it("still marks a real computation available", async () => {
    loadTestConfig({ QUANT_ENABLED: "true" });
    getCandles.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => ({
        open: 1 + i * 0.01, high: 1 + i * 0.01, low: 1 + i * 0.01,
        close: 1 + i * 0.01, volume: 100, timestamp: new Date(),
      }))
    );

    expect((await FeatureEngine.getInstance().compute("STX")).available).toBe(true);
  });

  it("fuses unavailable features to a zero-confidence HOLD, not a SELL", async () => {
    const features = await FeatureEngine.getInstance().compute("STX");
    const forecast = SignalFusionService.getInstance().fuse(1, "STX", features);

    // EMA12 === EMA26 in a placeholder set, which the trend sub-system scores
    // as a bearish crossover. That is a signal derived from an absence.
    expect(forecast.direction).toBe("HOLD");
    expect(forecast.confidence).toBe(0);
  });

  it("leaves a requested trade size untouched", async () => {
    const features = await FeatureEngine.getInstance().compute("STX");
    const forecast = SignalFusionService.getInstance().fuse(1, "STX", features);

    const size = PortfolioOptimizer.getInstance().optimizeSizing("BUY", 100, features, forecast, 1000, 25);

    expect(size).toBe(100);
  });

  it("does not fire an ATR stop computed from a zero ATR", async () => {
    const features = await FeatureEngine.getInstance().compute("STX");

    const decision = ExitPlanner.getInstance().computeAdaptiveStop("STX", 10, 9, 12, features);

    // A zero ATR puts the stop exactly at the entry price, which liquidates
    // the position on the first tick below it.
    expect(decision.shouldExit).toBe(false);
  });

  /**
   * The rule that keeps the product running. Half the gates in
   * STRATEGY_REGIME_GATES omit UNKNOWN — grid, breakout, momentum and mean
   * reversion — so a gate that reads UNKNOWN when quant is off doesn't stop
   * *consulting technical signals*, it stops trading.
   */
  it("lets every deterministic strategy through the regime gate", async () => {
    const regime = RegimeDetectionService.getInstance();

    for (const type of ["grid", "dca", "breakout", "momentum", "meanReversion", "sniper"]) {
      expect(await regime.isStrategyAllowed(type, "STX")).toBe(true);
    }
  });

  it("reports the regime as UNKNOWN rather than inventing one", async () => {
    expect(await RegimeDetectionService.getInstance().detectRegime("STX")).toBe("UNKNOWN");
  });

  it("returns an empty market context instead of placeholder snapshots", async () => {
    const context = await MarketDataService.getInstance().getContext(["STX", "WETH"]);

    // Every consumer reads this map with .get() and already copes with a
    // missing token; none of them can tell a $0 snapshot from a measured one.
    expect(context.snapshots.size).toBe(0);
    expect(context.macroRegime).toBe("UNKNOWN");
  });
});
