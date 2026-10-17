import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const redisStore = new Map<string, string>();
const getTokenPrice = vi.fn();

vi.mock("../../src/services/redis.js", () => ({
  RedisService: {
    getInstance: () => ({
      get: async (key: string) => redisStore.get(key) ?? null,
      set: async (key: string, value: string) => {
        redisStore.set(key, value);
      },
    }),
  },
}));

vi.mock("../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: { getInstance: () => ({ getTokenPrice }) },
}));

const { PriceHistoryService } = await import("../../src/services/priceHistory.js");

/**
 * `getHistory` used to invent its own history when it had none: a hundred
 * points of random walk seeded from the current spot price, written to Redis
 * so the fabrication persisted. `computeVolatility` then measured the
 * volatility *of that random walk*, and the number reached marketMaker,
 * breakout, meanReversion, rotational, portfolioRebalance and stopLossTp —
 * live strategies sizing real trades against Math.random().
 *
 * Every `compute*` method also returned 0 for "no data", which is not the same
 * fact and in one case inverted a ranking. See the rotational suite.
 */

const CHAIN = "solana:mainnet";

describe("PriceHistoryService", () => {
  const ph = PriceHistoryService.getInstance();

  beforeEach(() => {
    redisStore.clear();
    getTokenPrice.mockReset();
    // Reach into the memory buffer so each case starts genuinely cold.
    (ph as unknown as { memory: Map<string, unknown> }).memory.clear();
  });

  describe("no fabrication", () => {
    it("returns nothing for a token it has never seen", async () => {
      expect(await ph.getHistory(CHAIN, "NEW", 50)).toEqual([]);
    });

    it("does not ask the DEX registry for a price to seed from", async () => {
      getTokenPrice.mockResolvedValue(1.23);
      await ph.getHistory(CHAIN, "NEW", 50);
      expect(getTokenPrice).not.toHaveBeenCalled();
    });

    it("writes nothing to Redis when it has no history", async () => {
      getTokenPrice.mockResolvedValue(1.23);
      await ph.getHistory(CHAIN, "NEW", 50);
      expect(redisStore.size).toBe(0);
    });

    /**
     * A guard rather than a behaviour test. Fabricated market data is easy to
     * reintroduce as a convenience during a cold start and impossible to spot
     * downstream once it is persisted, so the absence is asserted directly.
     */
    it("contains no random number generation at all", () => {
      const source = readFileSync("src/services/priceHistory.ts", "utf8");
      expect(source).not.toMatch(/Math\.random/);
    });
  });

  describe("real history", () => {
    beforeEach(async () => {
      for (const price of [100, 102, 101, 105, 103]) {
        await ph.record(CHAIN, "SOL", price);
      }
    });

    it("returns the recorded points, most recent last", async () => {
      expect(await ph.getHistory(CHAIN, "SOL", 5)).toEqual([100, 102, 101, 105, 103]);
    });

    it("returns the last N when asked for fewer", async () => {
      expect(await ph.getHistory(CHAIN, "SOL", 2)).toEqual([105, 103]);
    });

    it("computes a moving average over what it actually has", async () => {
      expect(await ph.computeMovingAverage(CHAIN, "SOL", 5)).toBeCloseTo(102.2, 5);
    });

    it("computes high and low", async () => {
      expect(await ph.computeHigh(CHAIN, "SOL", 5)).toBe(105);
      expect(await ph.computeLow(CHAIN, "SOL", 5)).toBe(100);
    });

    it("computes momentum as percent change across the window", async () => {
      expect(await ph.computeMomentum(CHAIN, "SOL", 5)).toBeCloseTo(3, 5);
    });

    it("computes a non-null volatility", async () => {
      const vol = await ph.computeVolatility(CHAIN, "SOL", 5);
      expect(vol).not.toBeNull();
      expect(vol!).toBeGreaterThan(0);
    });
  });

  /**
   * Zero is a measurement: a flat price has zero volatility and zero momentum,
   * and an average of zero is a token that costs nothing. None of them is
   * "we have no data", so none of them may be the sentinel for it.
   */
  describe("insufficient data reports null, not zero", () => {
    it("computeVolatility needs two points", async () => {
      expect(await ph.computeVolatility(CHAIN, "EMPTY", 30)).toBeNull();
      await ph.record(CHAIN, "ONE", 100);
      expect(await ph.computeVolatility(CHAIN, "ONE", 30)).toBeNull();
    });

    it("computeMomentum needs two points", async () => {
      expect(await ph.computeMomentum(CHAIN, "EMPTY", 30)).toBeNull();
    });

    it("computeMovingAverage needs one point", async () => {
      expect(await ph.computeMovingAverage(CHAIN, "EMPTY", 30)).toBeNull();
    });

    it("computeHigh and computeLow need one point", async () => {
      expect(await ph.computeHigh(CHAIN, "EMPTY", 30)).toBeNull();
      expect(await ph.computeLow(CHAIN, "EMPTY", 30)).toBeNull();
    });

    it("distinguishes a genuinely flat price from missing data", async () => {
      for (const price of [50, 50, 50]) await ph.record(CHAIN, "FLAT", price);

      expect(await ph.computeVolatility(CHAIN, "FLAT", 30)).toBe(0);
      expect(await ph.computeMomentum(CHAIN, "FLAT", 30)).toBe(0);
      expect(await ph.computeMovingAverage(CHAIN, "FLAT", 30)).toBe(50);
    });
  });

  /**
   * Series were keyed by symbol alone, so the same ticker observed on two
   * chains — ETH from a Base wallet and from a Robinhood wallet, or two
   * unrelated tokens sharing a ticker — was interleaved into one series, and
   * every indicator was computed across more than one market.
   */
  describe("chain separation", () => {
    it("keeps a symbol's series separate per chain", async () => {
      await ph.record("base:mainnet", "ETH", 3000);
      await ph.record("robinhood:mainnet", "ETH", 10);

      expect(await ph.getHistory("base:mainnet", "ETH", 10)).toEqual([3000]);
      expect(await ph.getHistory("robinhood:mainnet", "ETH", 10)).toEqual([10]);
    });

    it("persists under a chain-qualified Redis key", async () => {
      await ph.record("base:mainnet", "eth", 3000);
      expect([...redisStore.keys()]).toEqual(["pricehistory:base:mainnet:ETH"]);
    });
  });
});
