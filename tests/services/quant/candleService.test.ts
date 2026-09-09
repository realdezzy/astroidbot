import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const mockIndexedToken = { findFirst: vi.fn() };
const mockIndexedPool = { findFirst: vi.fn() };
const mockPoolCandle = { findMany: vi.fn() };
const mockCandle = { findMany: vi.fn(), createMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() };

vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({
      prisma: {
        indexedToken: mockIndexedToken,
        indexedPool: mockIndexedPool,
        poolCandle: mockPoolCandle,
        candle: mockCandle,
      },
    }),
  },
}));

const { CandleService } = await import("../../../src/services/quant/candleService.js");

/**
 * `getCandles` used to call `autoSeed` whenever it found no rows, which
 * generated OHLCV from `Math.random()` — including a volume of
 * `1000 + Math.random() * 10000`, a number with no referent at all — and wrote
 * it to the `Candle` table with `createMany`. Once persisted, nothing
 * downstream could distinguish it from a real measurement, and the chart
 * endpoint, the feature engine and portfolio analytics all read it.
 *
 * `recordPrice` was the only thing that would have written real rows to that
 * table and nothing ever called it, so every row in `Candle` was fabricated.
 * Candles now come from `PoolCandle`, which the indexer writes from observed
 * swaps.
 */

/**
 * `getCandles` reads `orderBy: { bucketStart: "desc" }`, so these stubs answer
 * newest first — matching what Prisma would actually return.
 */
const newestFirst = <T>(rows: T[]): T[] => [...rows].reverse();

const bucket = (minute: number, over: Partial<Record<string, number>> = {}) => ({
  bucketStart: new Date(Date.UTC(2026, 0, 1, 12, minute)),
  open: 100,
  high: 110,
  low: 90,
  close: 105,
  volumeUsd: 1000,
  ...over,
});

describe("CandleService", () => {
  const svc = CandleService.getInstance();

  beforeEach(() => {
    vi.resetAllMocks();
    mockIndexedToken.findFirst.mockResolvedValue({ contractId: "0xabc", symbol: "WETH" });
    mockIndexedPool.findFirst.mockResolvedValue({ id: 7, liquidityUsd: 50_000 });
    mockPoolCandle.findMany.mockResolvedValue([]);
  });

  describe("no fabrication", () => {
    it("returns nothing when the index holds no candles for the token", async () => {
      expect(await svc.getCandles("WETH", "5m", 100, "base:mainnet")).toEqual([]);
    });

    it("writes nothing when it has no data", async () => {
      await svc.getCandles("WETH", "5m", 100, "base:mainnet");
      expect(mockCandle.createMany).not.toHaveBeenCalled();
      expect(mockCandle.create).not.toHaveBeenCalled();
    });

    it("returns nothing for a token the index has never seen", async () => {
      mockIndexedToken.findFirst.mockResolvedValue(null);
      expect(await svc.getCandles("NOSUCH", "1h", 100, "base:mainnet")).toEqual([]);
    });

    it("returns nothing for a token with no pool", async () => {
      mockIndexedPool.findFirst.mockResolvedValue(null);
      expect(await svc.getCandles("WETH", "1h", 100, "base:mainnet")).toEqual([]);
    });

    /**
     * A guard, not a behaviour test. Fabricated candles are trivial to
     * reintroduce as a cold-start convenience and impossible to identify
     * downstream once written, so their absence is asserted directly.
     */
    it("contains no random number generation at all", () => {
      // Comments are stripped first: this file documents what was removed and
      // names it, so a naive match would be satisfied by the explanation.
      const code = readFileSync("src/services/quant/candleService.ts", "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/Math\.random/);
      expect(code).not.toMatch(/autoSeed/);
    });
  });

  describe("serving real index data", () => {
    it("returns the index's five-minute buckets unchanged at 5m", async () => {
      mockPoolCandle.findMany.mockResolvedValue(newestFirst([bucket(0), bucket(5), bucket(10)]));

      const candles = await svc.getCandles("WETH", "5m", 100, "base:mainnet");

      expect(candles).toHaveLength(3);
      expect(candles[0]!.timestamp.getUTCMinutes()).toBe(0);
      expect(candles[2]!.timestamp.getUTCMinutes()).toBe(10);
    });

    it("reads from the deepest pool, matching how the rollup picks a price", async () => {
      await svc.getCandles("WETH", "5m", 100, "base:mainnet");

      const args = mockIndexedPool.findFirst.mock.calls[0]![0] as {
        orderBy: { liquidityUsd: { sort: string; nulls: string } };
      };
      expect(args.orderBy.liquidityUsd.sort).toBe("desc");
    });

    /**
     * Aggregation has to preserve OHLC semantics: open is the first bucket's
     * open and close is the last bucket's close, not the extremes. Taking the
     * high as the open is the classic way to get a chart that looks plausible
     * and is wrong.
     */
    it("aggregates five-minute buckets into the requested timeframe", async () => {
      mockPoolCandle.findMany.mockResolvedValue(
        newestFirst([
          bucket(0, { open: 100, high: 120, low: 95, close: 110, volumeUsd: 10 }),
          bucket(5, { open: 110, high: 130, low: 80, close: 115, volumeUsd: 20 }),
          bucket(10, { open: 115, high: 118, low: 105, close: 117, volumeUsd: 30 }),
        ])
      );

      const [candle, ...rest] = await svc.getCandles("WETH", "15m", 100, "base:mainnet");

      expect(rest).toHaveLength(0);
      expect(candle!.open).toBe(100); //  first bucket's open
      expect(candle!.close).toBe(117); //  last bucket's close
      expect(candle!.high).toBe(130); //   highest high
      expect(candle!.low).toBe(80); //     lowest low
      expect(candle!.volume).toBe(60); //  summed
    });

    it("splits buckets across timeframe boundaries", async () => {
      mockPoolCandle.findMany.mockResolvedValue(
        newestFirst([
          bucket(0, { close: 101, volumeUsd: 1 }),
          bucket(5, { close: 102, volumeUsd: 1 }),
          bucket(10, { close: 103, volumeUsd: 1 }),
          bucket(15, { close: 104, volumeUsd: 1 }),
        ])
      );

      const candles = await svc.getCandles("WETH", "15m", 100, "base:mainnet");

      expect(candles).toHaveLength(2);
      expect(candles[0]!.close).toBe(103);
      expect(candles[1]!.close).toBe(104);
    });

    it("returns candles oldest first", async () => {
      mockPoolCandle.findMany.mockResolvedValue(newestFirst([bucket(0), bucket(5), bucket(10)]));
      const candles = await svc.getCandles("WETH", "5m", 100, "base:mainnet");
      const times = candles.map((c) => c.timestamp.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it("honours the limit after aggregating, not before", async () => {
      mockPoolCandle.findMany.mockResolvedValue(newestFirst([bucket(0), bucket(5), bucket(10), bucket(15)]));
      const candles = await svc.getCandles("WETH", "15m", 1, "base:mainnet");
      expect(candles).toHaveLength(1);
      // The most recent window is the one worth keeping.
      expect(candles[0]!.timestamp.getUTCMinutes()).toBe(15);
    });
  });

  /**
   * The index's finest resolution is a five-minute bucket. A 1m chart cannot
   * be served from it, and interpolating one would be inventing data again —
   * the exact thing this change removes.
   */
  it("returns nothing for a timeframe finer than the index records", async () => {
    mockPoolCandle.findMany.mockResolvedValue(newestFirst([bucket(0), bucket(5)]));
    expect(await svc.getCandles("WETH", "1m", 100, "base:mainnet")).toEqual([]);
  });
});
