import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadTestConfig } from "../../helpers/config.js";

/**
 * Discovery mode, and the thing about it most likely to break quietly.
 *
 * `TokenDiscoveryService.promoteIndexedTokens` filters indexed tokens on
 * `lastRolledUpAt: { not: null }` — a token nothing has rolled up has no
 * trustworthy liquidity reading, so the floor above it cannot be applied. The
 * only thing that ever set that column was the candle rollup, and discovery
 * mode writes no candles. Without a substitute the catalogue would simply stop
 * gaining rows: no error, no warning, and "no new tokens" is also exactly what
 * a quiet chain looks like.
 */

const prisma = vi.hoisted(() => ({
  indexedPool: { findMany: vi.fn() },
  indexedToken: { findMany: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}));

vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => ({ prisma }) },
}));

const { RollupService } = await import("../../../src/services/indexer/rollupService.js");
const { indexerSettings, ingestionEnabled, backfillEnabled } = await import(
  "../../../src/services/indexer/settings.js"
);

/** The write `stampChain` produced for one token. */
function writtenData(index = 0): Record<string, unknown> {
  const call = prisma.indexedToken.update.mock.calls[index]![0] as { data: Record<string, unknown> };
  return call.data;
}

describe("indexer discovery mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadTestConfig();
    prisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);
  });

  describe("settings", () => {
    it("defaults to full, matching the unflipped market-data provider", () => {
      // `discovery` is where this deployment is going, but it is only coherent
      // alongside an external MARKET_DATA_PROVIDER, and that default has not
      // flipped. Pairing discovery mode with the `internal` provider would
      // leave the price column served from rollups nothing refreshes — ageing
      // silently rather than failing. The two defaults move together.
      const settings = indexerSettings();
      expect(settings.mode).toBe("full");
      expect(ingestionEnabled(settings)).toBe(true);
    });

    it("reads no swaps in discovery mode", () => {
      loadTestConfig({ INDEXER_MODE: "discovery" });
      const settings = indexerSettings();
      expect(settings.mode).toBe("discovery");
      expect(ingestionEnabled(settings)).toBe(false);
    });

    it("restores swap ingestion under full, the rollback path", () => {
      loadTestConfig({ INDEXER_MODE: "full" });
      expect(ingestionEnabled(indexerSettings())).toBe(true);
    });

    /**
     * The backfill is a walk through history's *swaps*. Left enabled, discovery
     * mode would decline to read the forward range and then spend the same
     * budget walking backwards through it.
     */
    it("stops the downward history walk with ingestion", () => {
      loadTestConfig({ INDEXER_MODE: "discovery", INDEXER_BACKFILL_WINDOW_HOURS: "24" });
      expect(backfillEnabled(indexerSettings())).toBe(false);

      loadTestConfig({ INDEXER_MODE: "full", INDEXER_BACKFILL_WINDOW_HOURS: "24" });
      expect(backfillEnabled(indexerSettings())).toBe(true);
    });
  });

  describe("stamping tokens without a candle rollup", () => {
    it("sets lastRolledUpAt so the catalogue keeps promoting", async () => {
      prisma.indexedPool.findMany.mockResolvedValue([
        { baseToken: "0xabc", dexId: "uniswap-v3", liquidityUsd: 40_000, pairCreatedAt: new Date("2026-01-02") },
      ]);
      prisma.indexedToken.findMany.mockResolvedValue([{ id: 1, contractId: "0xabc" }]);

      const updated = await RollupService.getInstance().stampChain("base:mainnet");

      expect(updated).toBe(1);
      expect(writtenData().lastRolledUpAt).toBeInstanceOf(Date);
      expect(writtenData().liquidityUsd).toBe(40_000);
    });

    /**
     * The catalogue's promotion filter, restated as an assertion: liquidity
     * above the floor *and* a rollup timestamp. This is the pair that has to
     * hold, and the stamp exists only to make it hold.
     */
    it("produces a row that clears the promotion filter", async () => {
      prisma.indexedPool.findMany.mockResolvedValue([
        { baseToken: "0xabc", dexId: "uniswap-v3", liquidityUsd: 5_000, pairCreatedAt: null },
      ]);
      prisma.indexedToken.findMany.mockResolvedValue([{ id: 1, contractId: "0xabc" }]);

      const { MIN_LIQUIDITY_USD } = await import("../../../src/services/tokenDiscovery.js");
      await RollupService.getInstance().stampChain("base:mainnet");

      const data = writtenData();
      expect(Number(data.liquidityUsd)).toBeGreaterThanOrEqual(MIN_LIQUIDITY_USD);
      expect(data.lastRolledUpAt).not.toBeNull();
    });

    it("sums a token's pools and credits the deepest one as its venue", async () => {
      prisma.indexedPool.findMany.mockResolvedValue([
        { baseToken: "0xabc", dexId: "uniswap-v2", liquidityUsd: 100, pairCreatedAt: new Date("2026-02-01") },
        { baseToken: "0xabc", dexId: "uniswap-v3", liquidityUsd: 900, pairCreatedAt: new Date("2026-01-01") },
      ]);
      prisma.indexedToken.findMany.mockResolvedValue([{ id: 1, contractId: "0xabc" }]);

      await RollupService.getInstance().stampChain("base:mainnet");

      expect(writtenData().liquidityUsd).toBe(1000);
      expect(writtenData().dexId).toBe("uniswap-v3");
      // Age is "how long has this been tradeable", not "…in this pool".
      expect(writtenData().pairCreatedAt).toEqual(new Date("2026-01-01"));
    });

    /**
     * The whole point of separating the two folds. A zero volume claims the
     * token didn't trade; the truth is that we stopped counting, and the two
     * sort to opposite ends of a volume-ranked table.
     */
    it("never writes price, volume or transaction counts", async () => {
      prisma.indexedPool.findMany.mockResolvedValue([
        { baseToken: "0xabc", dexId: "uniswap-v3", liquidityUsd: 100, pairCreatedAt: null },
      ]);
      prisma.indexedToken.findMany.mockResolvedValue([{ id: 1, contractId: "0xabc" }]);

      await RollupService.getInstance().stampChain("base:mainnet");

      const data = writtenData();
      for (const column of ["priceUsd", "volume24h", "txnsBuys24h", "txnsSells24h", "priceChange24h"]) {
        expect(data).not.toHaveProperty(column);
      }
    });

    it("creates no row for a pool whose token has no identity", async () => {
      prisma.indexedPool.findMany.mockResolvedValue([
        { baseToken: "0xunknown", dexId: "uniswap-v3", liquidityUsd: 100, pairCreatedAt: null },
      ]);
      // Identity comes from pool discovery reading symbol() and name(); a row
      // invented here could never render.
      prisma.indexedToken.findMany.mockResolvedValue([]);

      expect(await RollupService.getInstance().stampChain("base:mainnet")).toBe(0);
      expect(prisma.indexedToken.update).not.toHaveBeenCalled();
    });

    it("ignores pools whose depth was never measured", async () => {
      prisma.indexedPool.findMany.mockResolvedValue([]);

      expect(await RollupService.getInstance().stampChain("base:mainnet")).toBe(0);

      const where = (prisma.indexedPool.findMany.mock.calls[0]![0] as {
        where: { liquidityUsd: unknown };
      }).where;
      expect(where.liquidityUsd).toEqual({ not: null });
    });
  });
});
