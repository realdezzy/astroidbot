import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { ConfigManager } from "../../src/config.js";

const mockToken = {
  upsert: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  findUnique: vi.fn(),
};

vi.mock("../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => ({ prisma: { token: mockToken } }) },
}));

const mockDexRegistry = {
  getSwappableTokens: vi.fn(),
  getTokenPrice: vi.fn(),
};

vi.mock("../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: { getInstance: () => mockDexRegistry },
}));

/**
 * Stub market-data provider. TokenDiscoveryService talks to the
 * MarketDataProvider interface now rather than to DexScreener directly, so the
 * tests drive it through the same seam production swaps implementations on.
 */
const mockMarketData = {
  name: "stub",
  supportsChain: vi.fn().mockReturnValue(true),
  getMarketData: vi.fn().mockResolvedValue(new Map()),
  search: vi.fn().mockResolvedValue([]),
  topTokens: vi.fn().mockResolvedValue([]),
};

const tradableChains: { chainId: string }[] = [];
/** Registry contents drive the testnet filter, so `list` matters here too. */
const registeredChains: { chainId: string; isTestnet: boolean }[] = [];

vi.mock("../../src/services/chains/chainAdapterRegistry.js", () => ({
  ChainAdapterRegistry: {
    getInstance: () => ({
      tradable: () => tradableChains,
      list: () => registeredChains,
    }),
  },
}));

describe("TokenDiscoveryService", () => {
  let service: import("../../src/services/tokenDiscovery.js").TokenDiscoveryService;
  let MIN_LIQUIDITY_USD: number;

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.load();
    const mod = await import("../../src/services/tokenDiscovery.js");
    service = mod.TokenDiscoveryService.getInstance();
    MIN_LIQUIDITY_USD = mod.MIN_LIQUIDITY_USD;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    tradableChains.length = 0;
    registeredChains.length = 0;
    mockToken.upsert.mockResolvedValue({});
    mockToken.findMany.mockResolvedValue([]);
    mockToken.count.mockResolvedValue(0);
    mockMarketData.getMarketData.mockResolvedValue(new Map());
    mockMarketData.search.mockResolvedValue([]);
    service.setMarketDataProvider(mockMarketData);
  });

  describe("syncChain", () => {
    it("stores each token keyed by chain and contract", async () => {
      mockDexRegistry.getSwappableTokens.mockResolvedValue([
        { contractId: "0xusdc", symbol: "USDC", name: "USD Coin", decimals: 6 },
      ]);
      mockDexRegistry.getTokenPrice.mockResolvedValue(1);

      const count = await service.syncChain("base:mainnet");

      expect(count).toBe(1);
      expect(mockToken.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { chainId_contractId: { chainId: "base:mainnet", contractId: "0xusdc" } },
        })
      );
    });

    it("does not overwrite a stored price when the quote comes back zero", async () => {
      // A transient RPC failure returning 0 would otherwise wipe a good price
      // and make the token look worthless on the discovery page.
      mockDexRegistry.getSwappableTokens.mockResolvedValue([
        { contractId: "0xusdc", symbol: "USDC", name: "USD Coin", decimals: 6 },
      ]);
      mockDexRegistry.getTokenPrice.mockResolvedValue(0);

      await service.syncChain("base:mainnet");

      const call = mockToken.upsert.mock.calls[0]![0];
      expect(call.update).not.toHaveProperty("priceUsd");
      // On create the column is simply omitted, which stores NULL — the same
      // outcome as passing null explicitly, and the point is that no bogus
      // zero is written either way.
      expect(call.create.priceUsd ?? null).toBeNull();
    });

    it("keeps syncing after one token fails", async () => {
      mockDexRegistry.getSwappableTokens.mockResolvedValue([
        { contractId: "0xbad", symbol: "BAD", name: "Bad", decimals: 18 },
        { contractId: "0xgood", symbol: "GOOD", name: "Good", decimals: 18 },
      ]);
      mockDexRegistry.getTokenPrice.mockResolvedValue(1);
      mockToken.upsert.mockRejectedValueOnce(new Error("db blip"));

      expect(await service.syncChain("base:mainnet")).toBe(1);
    });
  });

  describe("syncAll", () => {
    it("syncs every tradable chain", async () => {
      tradableChains.push({ chainId: "base:mainnet" }, { chainId: "celo:mainnet" });
      mockDexRegistry.getSwappableTokens.mockResolvedValue([
        { contractId: "0x1", symbol: "A", name: "A", decimals: 18 },
      ]);
      mockDexRegistry.getTokenPrice.mockResolvedValue(1);

      const result = await service.syncAll();

      expect(result.chains).toBe(2);
      expect(result.tokens).toBe(2);
    });

    it("continues when one chain's RPC is down", async () => {
      // One dead chain must not stop the others from syncing.
      tradableChains.push({ chainId: "base:mainnet" }, { chainId: "celo:mainnet" });
      mockDexRegistry.getSwappableTokens
        .mockRejectedValueOnce(new Error("rpc down"))
        .mockResolvedValueOnce([{ contractId: "0x1", symbol: "A", name: "A", decimals: 18 }]);
      mockDexRegistry.getTokenPrice.mockResolvedValue(1);

      const result = await service.syncAll();
      expect(result.tokens).toBe(1);
    });
  });

  describe("discover", () => {
    it("filters out tokens below the liquidity floor by default", async () => {
      // A DEX-derived price on a shallow pool says more about the pool than
      // the token, and anyone can seed one.
      await service.discover({});
      const where = mockToken.findMany.mock.calls[0]![0].where;
      expect(where.OR).toEqual([
        { liquidityUsd: null },
        { liquidityUsd: { gte: MIN_LIQUIDITY_USD } },
      ]);
    });

    it("keeps tokens whose liquidity is unknown rather than assuming zero", async () => {
      await service.discover({});
      const where = mockToken.findMany.mock.calls[0]![0].where;
      // Absent means "not yet measured"; excluding it would hide every
      // freshly-synced token.
      expect(where.OR).toContainEqual({ liquidityUsd: null });
    });

    it("can be asked for illiquid tokens explicitly", async () => {
      await service.discover({ includeIlliquid: true });
      expect(mockToken.findMany.mock.calls[0]![0].where.OR).toBeUndefined();
    });

    it("scopes to one chain when asked", async () => {
      await service.discover({ chainId: "celo:mainnet" });
      expect(mockToken.findMany.mock.calls[0]![0].where.chainId).toBe("celo:mainnet");
    });

    it("sorts volume descending with nulls last", async () => {
      // Postgres defaults DESC to NULLS FIRST, which would rank unmeasured
      // tokens above established ones.
      await service.discover({ sort: "volume" });
      expect(mockToken.findMany.mock.calls[0]![0].orderBy).toEqual([
        { volume24h: { sort: "desc", nulls: "last" } },
      ]);
    });

    it("clamps page size so one request can't ask for the whole table", async () => {
      await service.discover({ pageSize: 10_000 });
      expect(mockToken.findMany.mock.calls[0]![0].take).toBe(100);
    });

    it("normalises a nonsense page number", async () => {
      await service.discover({ page: -5 });
      expect(mockToken.findMany.mock.calls[0]![0].skip).toBe(0);
    });

    it("searches symbol, name and contract", async () => {
      await service.discover({ query: "usdc" });
      const and = mockToken.findMany.mock.calls[0]![0].where.AND;
      expect(and[0].OR).toHaveLength(3);
    });

    it("handles category trending filter by volume sort", async () => {
      await service.discover({ category: "trending" });
      expect(mockToken.findMany.mock.calls[0]![0].orderBy).toEqual([
        { volume24h: { sort: "desc", nulls: "last" } },
      ]);
    });

    it("handles category gainers filter by price change sort", async () => {
      await service.discover({ category: "gainers" });
      expect(mockToken.findMany.mock.calls[0]![0].orderBy).toEqual([
        { priceChange24h: { sort: "desc", nulls: "last" } },
      ]);
    });

    it("handles category new filter with date threshold", async () => {
      await service.discover({ category: "new" });
      const where = mockToken.findMany.mock.calls[0]![0].where;
      expect(where.pairCreatedAt).toHaveProperty("gte");
      expect(mockToken.findMany.mock.calls[0]![0].orderBy).toEqual([
        { pairCreatedAt: { sort: "desc", nulls: "last" } },
      ]);
    });
  });
});

