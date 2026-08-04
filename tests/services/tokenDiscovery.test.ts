import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { ConfigManager } from "../../src/config.js";

const mockToken = {
  upsert: vi.fn(),
  findMany: vi.fn(),
  createMany: vi.fn(),
  count: vi.fn(),
  findUnique: vi.fn(),
};

/**
 * The indexer's table. It is mocked read-only on purpose: this service is the
 * backend, and the backend never writes here. If a write method ever needs
 * adding to make a test pass, the boundary has been crossed.
 */
const mockIndexedToken = {
  findMany: vi.fn(),
};

vi.mock("../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({ prisma: { token: mockToken, indexedToken: mockIndexedToken } }),
  },
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
    mockToken.createMany.mockResolvedValue({ count: 0 });
    mockToken.count.mockResolvedValue(0);
    mockIndexedToken.findMany.mockResolvedValue([]);
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

    it("refreshes metrics for catalogued tokens no provider lists", async () => {
      // Tokens promoted out of the index are in no DEX provider's list. If the
      // sync only walked that list, a promoted token would sit on the
      // discovery page with identity and permanently blank numbers.
      mockDexRegistry.getSwappableTokens.mockResolvedValue([
        { contractId: "0xusdc", symbol: "USDC", name: "USD Coin", decimals: 6 },
      ]);
      mockToken.findMany.mockResolvedValue([
        { contractId: "0xusdc", symbol: "USDC", name: "USD Coin", decimals: 6 },
        { contractId: "0xlongtail", symbol: "TAIL", name: "Long Tail", decimals: 18 },
      ]);
      mockDexRegistry.getTokenPrice.mockResolvedValue(1);

      await service.syncChain("base:mainnet");

      const synced = mockToken.upsert.mock.calls.map(
        (c) => c[0].where.chainId_contractId.contractId
      );
      expect(synced).toContain("0xlongtail");
      // …once. The listed token must not be synced twice for being in both.
      expect(synced.filter((id: string) => id === "0xusdc")).toHaveLength(1);
    });

    it("does not ask the DEX to quote a token it cannot route", async () => {
      // A promoted token is by definition in no provider list, so quoting it is
      // a guaranteed round trip to "no route" — several hundred per pass.
      mockDexRegistry.getSwappableTokens.mockResolvedValue([]);
      mockToken.findMany.mockResolvedValue([
        { contractId: "0xlongtail", symbol: "TAIL", name: "Long Tail", decimals: 18 },
      ]);

      await service.syncChain("base:mainnet");

      expect(mockDexRegistry.getTokenPrice).not.toHaveBeenCalled();
    });
  });

  describe("promotion from the index", () => {
    /**
     * The indexer writes IndexedToken and the backend writes Token. Promotion
     * is the one place the two meet, and it is a read here and a write there —
     * never the reverse.
     */
    it("copies indexed tokens the catalogue doesn't have yet", async () => {
      tradableChains.push({ chainId: "base:mainnet" });
      mockDexRegistry.getSwappableTokens.mockResolvedValue([]);
      mockIndexedToken.findMany.mockResolvedValue([
        { contractId: "0xnew", symbol: "NEW", name: "New Token", decimals: 18 },
        { contractId: "0xknown", symbol: "KNOWN", name: "Known", decimals: 18 },
      ]);
      mockToken.findMany.mockResolvedValue([{ contractId: "0xknown" }]);
      mockToken.createMany.mockResolvedValue({ count: 1 });

      const result = await service.syncAll();

      expect(result.promoted).toBe(1);
      const created = mockToken.createMany.mock.calls[0]![0].data;
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ contractId: "0xnew", symbol: "NEW", decimals: 18 });
    });

    it("only promotes tokens that cleared the liquidity floor and a rollup", async () => {
      // The indexer catalogues every token with a pool, scams included. The
      // catalogue is a listing decision, so the floor is applied on the way in.
      tradableChains.push({ chainId: "base:mainnet" });
      mockDexRegistry.getSwappableTokens.mockResolvedValue([]);

      await service.syncAll();

      const where = mockIndexedToken.findMany.mock.calls[0]![0].where;
      expect(where.liquidityUsd).toEqual({ gte: MIN_LIQUIDITY_USD });
      expect(where.lastRolledUpAt).toEqual({ not: null });
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

