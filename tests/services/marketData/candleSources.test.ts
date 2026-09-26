import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadTestConfig } from "../../helpers/config.js";

/**
 * The candle seam.
 *
 * `CandleService` used to query `poolCandle` / `indexedPool` / `indexedToken`
 * directly, which hard-wired every chart to our own swap index. These tests
 * pin the two properties that make the seam worth having: the source is chosen
 * by config, and a source that already returns the requested timeframe is not
 * folded a second time — re-aggregating aggregated candles produces a
 * plausible chart with the wrong opens, which is the worst available outcome.
 */

const api = vi.hoisted(() => ({ topPools: vi.fn(), ohlcv: vi.fn(), trades: vi.fn() }));
vi.mock("../../../src/services/geckoTerminal.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/services/geckoTerminal.js")>(
    "../../../src/services/geckoTerminal.js"
  );
  return { ...actual, GeckoTerminalService: { getInstance: () => api } };
});

const prisma = vi.hoisted(() => ({
  token: { findFirst: vi.fn() },
  indexedToken: { findFirst: vi.fn() },
  indexedPool: { findFirst: vi.fn() },
  poolCandle: { findMany: vi.fn() },
}));
vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => ({ prisma }) },
}));

const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("../../../src/services/redis.js", () => ({ RedisService: { getInstance: () => redis } }));

const { CandleService } = await import("../../../src/services/quant/candleService.js");
const { resolveCandleSource } = await import("../../../src/services/marketData/candles/index.js");

const svc = CandleService.getInstance();

/**
 * Cache writes for served candles only.
 *
 * The external source also caches which pool a token charts from, under its
 * own key and a much longer TTL — so "was anything written to Redis" is not
 * the question any of these assertions mean.
 */
function candleCacheWrites(): unknown[][] {
  return redis.set.mock.calls.filter((call) => String(call[0]).startsWith("candles:"));
}

/** One hourly candle, as the API hands it back. */
function ohlcv(tsSeconds: number, close: number) {
  return { timestampSeconds: tsSeconds, open: close - 1, high: close + 1, low: close - 2, close, volumeUsd: 10 };
}

describe("candle sources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadTestConfig();
    svc.setCandleSource(null);
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue(undefined);
    prisma.poolCandle.findMany.mockResolvedValue([]);
    prisma.indexedPool.findFirst.mockResolvedValue({ id: 7 });
    prisma.indexedToken.findFirst.mockResolvedValue({ contractId: "0xabc" });
    prisma.token.findFirst.mockResolvedValue(null);
    api.topPools.mockResolvedValue([{ address: "0xpool", reserveUsd: 100 }]);
    api.ohlcv.mockResolvedValue([]);
  });

  describe("resolution", () => {
    it("defaults to the internal source", () => {
      expect(resolveCandleSource().name).toBe("internal");
    });

    it("follows the market-data provider when set to auto", () => {
      loadTestConfig({ CANDLE_SOURCE: "auto", MARKET_DATA_PROVIDER: "hybrid" });
      expect(resolveCandleSource().name).toBe("geckoterminal");
    });

    /** The A/B: external prices against internal candles, on purpose. */
    it("honours an explicit source over the provider it would follow", () => {
      loadTestConfig({ CANDLE_SOURCE: "internal", MARKET_DATA_PROVIDER: "hybrid" });
      expect(resolveCandleSource().name).toBe("internal");
    });
  });

  describe("external source", () => {
    beforeEach(() => loadTestConfig({ CANDLE_SOURCE: "geckoterminal" }));

    it("serves the API's candles at the requested timeframe without re-folding", async () => {
      // Three hourly candles. Folded a second time into 1h they would still be
      // three — so the assertion that catches double aggregation is the 4h one
      // below; this one pins the mapping.
      api.ohlcv.mockResolvedValue([ohlcv(3_600, 101), ohlcv(7_200, 102), ohlcv(10_800, 103)]);

      const candles = await svc.getCandlesForContract("base:mainnet", "0xabc", "1h", 10);

      expect(candles.map((c) => c.close)).toEqual([101, 102, 103]);
      expect(candles[0]!.timestamp.getTime()).toBe(3_600_000);
    });

    it("does not fold already-aggregated candles into wider ones", async () => {
      // Four candles inside one 4-hour window. The internal source would fold
      // these to one; the external source asked for 4h candles and got them.
      api.ohlcv.mockResolvedValue([
        ohlcv(0, 100), ohlcv(3_600, 101), ohlcv(7_200, 102), ohlcv(10_800, 103),
      ]);

      const candles = await svc.getCandlesForContract("base:mainnet", "0xabc", "4h", 10);

      expect(candles).toHaveLength(4);
      expect(api.ohlcv).toHaveBeenCalledWith("base:mainnet", "0xpool", "4h", 10);
    });

    it("serves a 1m chart, which the five-minute index cannot", async () => {
      api.ohlcv.mockResolvedValue([ohlcv(60, 100)]);
      expect(await svc.getCandlesForContract("base:mainnet", "0xabc", "1m", 10)).toHaveLength(1);
    });

    it("returns nothing when the token has no pool, rather than inventing one", async () => {
      api.topPools.mockResolvedValue([]);
      expect(await svc.getCandlesForContract("base:mainnet", "0xabc", "1h", 10)).toEqual([]);
    });

    it("charts the deepest pool", async () => {
      api.topPools.mockResolvedValue([
        { address: "0xdust", reserveUsd: 5 },
        { address: "0xdeep", reserveUsd: 900_000 },
      ]);
      api.ohlcv.mockResolvedValue([ohlcv(3_600, 101)]);

      await svc.getCandlesForContract("base:mainnet", "0xabc", "1h", 10);

      expect(api.ohlcv).toHaveBeenCalledWith("base:mainnet", "0xdeep", "1h", 10);
    });
  });

  describe("caching", () => {
    beforeEach(() => loadTestConfig({ CANDLE_SOURCE: "geckoterminal" }));

    it("serves a cached series without calling the source", async () => {
      redis.get.mockResolvedValue(
        JSON.stringify([{ open: 1, high: 2, low: 0.5, close: 1.5, volume: 9, timestamp: "2026-01-01T00:00:00.000Z" }])
      );

      const candles = await svc.getCandlesForContract("base:mainnet", "0xabc", "1h", 10);

      expect(api.ohlcv).not.toHaveBeenCalled();
      // JSON has no date type and every consumer calls getTime() on this.
      expect(candles[0]!.timestamp).toBeInstanceOf(Date);
    });

    /**
     * An empty answer is usually a pool that is about to be discovered.
     * Caching the absence makes an empty chart outlive the moment it stopped
     * being true.
     */
    it("does not cache an empty answer", async () => {
      api.ohlcv.mockResolvedValue([]);
      await svc.getCandlesForContract("base:mainnet", "0xabc", "1h", 10);
      expect(candleCacheWrites()).toHaveLength(0);
    });

    it("gives a daily candle a longer TTL than a five-minute one", async () => {
      api.ohlcv.mockResolvedValue([ohlcv(3_600, 101)]);

      await svc.getCandlesForContract("base:mainnet", "0xabc", "5m", 10);
      const short = Number(candleCacheWrites()[0]![2]);

      await svc.getCandlesForContract("base:mainnet", "0xabc", "1d", 10);
      const long = Number(candleCacheWrites()[1]![2]);

      expect(long).toBeGreaterThan(short);
    });
  });
});
