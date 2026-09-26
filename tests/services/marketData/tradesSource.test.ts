import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadTestConfig } from "../../helpers/config.js";

/**
 * The trade-activity seam.
 *
 * `/swaps` and `/traders` queried `IndexedSwap` inline in the route handler,
 * which made the two most swap-shaped surfaces in the product the only ones
 * that could not follow the configured market-data source anywhere.
 */

const api = vi.hoisted(() => ({ topPools: vi.fn(), trades: vi.fn() }));
vi.mock("../../../src/services/geckoTerminal.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/services/geckoTerminal.js")>(
    "../../../src/services/geckoTerminal.js"
  );
  return { ...actual, GeckoTerminalService: { getInstance: () => api } };
});

const prisma = vi.hoisted(() => ({
  indexedPool: { findMany: vi.fn() },
  indexedSwap: { findMany: vi.fn(), groupBy: vi.fn() },
}));
vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => ({ prisma }) },
}));

const { resolveTradesSource, InternalTradesSource, GeckoTerminalTradesSource } = await import(
  "../../../src/services/marketData/trades/index.js"
);

describe("trades sources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadTestConfig();
    prisma.indexedPool.findMany.mockResolvedValue([{ id: 1 }]);
    prisma.indexedSwap.findMany.mockResolvedValue([]);
    prisma.indexedSwap.groupBy.mockResolvedValue([]);
    api.topPools.mockResolvedValue([{ address: "0xpool", reserveUsd: 100 }]);
    api.trades.mockResolvedValue([]);
  });

  it("follows the configured market-data provider", () => {
    expect(resolveTradesSource().name).toBe("internal");

    loadTestConfig({ MARKET_DATA_PROVIDER: "hybrid" });
    expect(resolveTradesSource().name).toBe("geckoterminal");
  });

  describe("internal", () => {
    const source = new InternalTradesSource();

    it("says why a list is empty rather than showing a bare empty table", async () => {
      prisma.indexedPool.findMany.mockResolvedValue([]);

      const feed = await source.recentSwaps("base:mainnet", "0xabc", 50);

      expect(feed.swaps).toEqual([]);
      // "No pools indexed" and "this token has not traded" are the same empty
      // array and different facts.
      expect(feed.note).toContain("No indexed pools");
    });

    it("reports the swap's own time, not when the row was written", async () => {
      const bucketStart = new Date("2026-01-01T00:00:00Z");
      prisma.indexedSwap.findMany.mockResolvedValue([
        {
          txKey: "0xdeadbeef:3",
          bucketStart,
          isBuy: true,
          volumeUsd: 100,
          priceUsd: 2,
          traderAddress: "0xtrader",
          createdAt: new Date("2026-06-01T00:00:00Z"),
        },
      ]);

      const feed = await source.recentSwaps("base:mainnet", "0xabc", 50);

      // During a backfill walk, `createdAt` stamped every trade in this list
      // "just now" however old it was.
      expect(feed.swaps[0]!.timestamp).toBe(bucketStart);
      // The stored key is "<txHash>:<logIndex>"; an explorer link needs the first half.
      expect(feed.swaps[0]!.txHash).toBe("0xdeadbeef");
    });

    it("bounds the leaderboard query to a recent window", async () => {
      await source.topTraders("base:mainnet", "0xabc", 20);

      const args = prisma.indexedSwap.groupBy.mock.calls[0]![0] as {
        where: { bucketStart: { gte: Date } };
        take: number;
      };
      expect(args.where.bucketStart.gte).toBeInstanceOf(Date);
      expect(args.take).toBe(20);
    });
  });

  describe("geckoterminal", () => {
    const source = new GeckoTerminalTradesSource();

    it("reads the deepest pool's feed", async () => {
      api.topPools.mockResolvedValue([
        { address: "0xdust", reserveUsd: 1 },
        { address: "0xdeep", reserveUsd: 900_000 },
      ]);

      await source.recentSwaps("base:mainnet", "0xabc", 50);

      expect(api.trades).toHaveBeenCalledWith("base:mainnet", "0xdeep");
    });

    it("says so when the chain isn't covered at all", async () => {
      const feed = await source.recentSwaps("arc:testnet", "0xabc", 50);
      expect(feed.note).toContain("not available for this chain");
      expect(api.topPools).not.toHaveBeenCalled();
    });

    it("folds a trader's volume without turning an unvalued trade into zero", async () => {
      api.trades.mockResolvedValue([
        { txHash: "0x1", traderAddress: "0xa", kind: "buy", volumeUsd: 100, priceUsd: 1, blockNumber: 1, timestamp: new Date() },
        { txHash: "0x2", traderAddress: "0xa", kind: "sell", volumeUsd: null, priceUsd: null, blockNumber: 2, timestamp: new Date() },
        { txHash: "0x3", traderAddress: "0xb", kind: "buy", volumeUsd: null, priceUsd: null, blockNumber: 3, timestamp: new Date() },
      ]);

      const feed = await source.topTraders("base:mainnet", "0xabc", 20);

      expect(feed.traders[0]).toMatchObject({ address: "0xa", volumeUsd: 100, trades: 2 });
      // A trader all of whose trades were unvalued has unknown volume, not $0.
      expect(feed.traders[1]).toMatchObject({ address: "0xb", volumeUsd: null, trades: 1 });
    });
  });
});
