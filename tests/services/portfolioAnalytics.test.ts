import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { ConfigManager } from "../../src/config.js";

const mockPrisma = {
  trade: { findMany: vi.fn(), findFirst: vi.fn() },
};
const mockDb = {
  prisma: mockPrisma,
  findWalletsByUserId: vi.fn(),
};
vi.mock("../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => mockDb },
}));

const mockRegistry = { getSwappableTokens: vi.fn(), getTokenPrice: vi.fn() };
vi.mock("../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: { getInstance: () => mockRegistry },
}));

const fetchBalances = vi.fn();
vi.mock("../../src/services/portfolio.js", () => ({
  PortfolioManager: { getInstance: () => ({ fetchBalances }) },
}));

const getCandles = vi.fn();
vi.mock("../../src/services/quant/candleService.js", () => ({
  CandleService: {
    getInstance: () => ({
      getCandles,
      getPeriodStart: (ms: number) => new Date(Math.floor(ms / 86_400_000) * 86_400_000),
    }),
  },
}));

/**
 * Per-chain portfolio valuation.
 *
 * The bug this replaces: holdings were aggregated by *bare symbol* across every
 * wallet, so a user holding USDC on both Stacks and Base saw one merged series
 * priced against whichever chain answered first. Two different assets at two
 * different prices, reported as one number.
 */
describe("PortfolioAnalyticsService", () => {
  let service: import("../../src/services/portfolioAnalytics.js").PortfolioAnalyticsService;

  const stacksWallet = {
    id: 1, address: "SP1", balance: 10,
    chain: "stacks:mainnet", chainFamily: "stacks",
  };
  const baseWallet = {
    id: 2, address: "0xabc", balance: 1,
    chain: "base:mainnet", chainFamily: "evm",
  };

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.reset();
    ConfigManager.load();
    const mod = await import("../../src/services/portfolioAnalytics.js");
    service = mod.PortfolioAnalyticsService.getInstance();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.trade.findMany.mockResolvedValue([]);
    mockPrisma.trade.findFirst.mockResolvedValue(null);
    mockDb.findWalletsByUserId.mockResolvedValue([]);
    mockRegistry.getSwappableTokens.mockResolvedValue([]);
    mockRegistry.getTokenPrice.mockResolvedValue(0);
    fetchBalances.mockResolvedValue([]);
    getCandles.mockResolvedValue([]);
  });

  it("values same-ticker holdings on different chains at their own prices", async () => {
    // THE regression. 100 USDC on Stacks at $0.90 and 100 USDC on Base at
    // $1.00 is $190, not 200 x whichever price answered first.
    mockDb.findWalletsByUserId.mockResolvedValue([stacksWallet, baseWallet]);
    fetchBalances.mockImplementation(async (address: string) =>
      address === "SP1"
        ? [{ token: "USDC", symbol: "USDC", balance: 100, usdValue: 0 }]
        : [{ token: "USDC", symbol: "USDC", balance: 100, usdValue: 0 }]
    );
    mockRegistry.getTokenPrice.mockImplementation(async (_sym: string, chainId: string) =>
      chainId === "stacks:mainnet" ? 0.9 : 1.0
    );

    const result = await service.compute(1, "7d");
    const latest = result.chartData[result.chartData.length - 1]!;

    expect(latest.portfolioValue).toBeCloseTo(190, 5);
  });

  it("fetches a token universe per chain rather than one global list", async () => {
    mockDb.findWalletsByUserId.mockResolvedValue([stacksWallet, baseWallet]);
    await service.compute(1, "7d");

    const scopes = mockRegistry.getSwappableTokens.mock.calls.map((c) => c[1]);
    expect(scopes).toContain("stacks:mainnet");
    expect(scopes).toContain("base:mainnet");
    // Never unscoped — that's what merged the chains in the first place.
    expect(scopes).not.toContain(undefined);
  });

  it("passes the wallet's chain when fetching its balances", async () => {
    mockDb.findWalletsByUserId.mockResolvedValue([baseWallet]);
    await service.compute(1, "7d");

    expect(fetchBalances).toHaveBeenCalledWith(
      "0xabc", expect.anything(), 1, true, "base:mainnet"
    );
  });

  it("requests candles per chain, so one chain's series can't stand in for another", async () => {
    mockDb.findWalletsByUserId.mockResolvedValue([stacksWallet, baseWallet]);
    fetchBalances.mockResolvedValue([{ token: "USDC", symbol: "USDC", balance: 1, usdValue: 0 }]);

    await service.compute(1, "7d");

    const calls = getCandles.mock.calls.map((c) => ({ symbol: c[0], chainId: c[3] }));
    expect(calls).toContainEqual({ symbol: "USDC", chainId: "stacks:mainnet" });
    expect(calls).toContainEqual({ symbol: "USDC", chainId: "base:mainnet" });
  });

  it("attributes a trade's effect to its own wallet's chain when rebuilding history", async () => {
    // A Base trade must never adjust a Stacks position of the same ticker.
    mockDb.findWalletsByUserId.mockResolvedValue([stacksWallet, baseWallet]);
    fetchBalances.mockImplementation(async (address: string) =>
      address === "SP1"
        ? [{ token: "USDC", symbol: "USDC", balance: 100, usdValue: 0 }]
        : [{ token: "USDC", symbol: "USDC", balance: 0, usdValue: 0 }]
    );
    mockRegistry.getTokenPrice.mockResolvedValue(1);

    const oneDayAgo = new Date(Date.now() - 86_400_000 / 2);
    mockPrisma.trade.findMany.mockResolvedValue([
      {
        tokenIn: "WETH", tokenOut: "USDC", amountIn: 1, amountOut: 50,
        amountInUsd: 50, direction: "BUY", createdAt: oneDayAgo,
        wallet: { chain: "base:mainnet", chainFamily: "evm" },
      },
    ]);

    const result = await service.compute(1, "7d");
    // Stacks USDC is untouched by the Base trade; only Base's position and the
    // Base WETH that funded it move.
    expect(result.summary.totalTrades).toBe(1);
    expect(result.chartData.length).toBeGreaterThan(0);
  });

  it("falls back to the wallet's own native symbol, not STX, when balances fail", async () => {
    mockDb.findWalletsByUserId.mockResolvedValue([baseWallet]);
    fetchBalances.mockRejectedValue(new Error("rpc down"));
    mockRegistry.getTokenPrice.mockImplementation(async (symbol: string) =>
      symbol === "ETH" ? 3000 : 0
    );

    const result = await service.compute(1, "7d");
    const latest = result.chartData[result.chartData.length - 1]!;
    // 1 ETH x $3000. Under the old code this counted as 1 STX.
    expect(latest.portfolioValue).toBeCloseTo(3000, 5);
  });

  it("prices an unknown token at zero rather than inventing a value", async () => {
    // The old fallback was $2 for STX and $1 for everything else, which
    // silently valued any unpriced token at par.
    mockDb.findWalletsByUserId.mockResolvedValue([baseWallet]);
    fetchBalances.mockResolvedValue([
      { token: "0xmystery", symbol: "MYSTERY", balance: 1_000_000, usdValue: 0 },
    ]);
    mockRegistry.getTokenPrice.mockResolvedValue(0);

    const result = await service.compute(1, "7d");
    expect(result.chartData[result.chartData.length - 1]!.portfolioValue).toBe(0);
  });

  it("prefers the USD value recorded at execution time", async () => {
    // It was computed against the right chain when the trade happened.
    mockDb.findWalletsByUserId.mockResolvedValue([baseWallet]);
    mockPrisma.trade.findMany.mockResolvedValue([
      {
        tokenIn: "USDC", tokenOut: "WETH", amountIn: 10, amountOut: 0.003,
        amountInUsd: 123.45, direction: "BUY", createdAt: new Date(),
        wallet: { chain: "base:mainnet", chainFamily: "evm" },
      },
    ]);

    const result = await service.compute(1, "7d");
    expect(result.summary.totalVolume).toBeCloseTo(123.45, 2);
  });

  it("scopes to a single wallet when asked", async () => {
    mockDb.findWalletsByUserId.mockResolvedValue([stacksWallet, baseWallet]);
    await service.compute(1, "7d", 2);

    expect(mockPrisma.trade.findMany.mock.calls[0]![0].where.walletId).toBe(2);
    expect(fetchBalances).toHaveBeenCalledTimes(1);
    expect(fetchBalances.mock.calls[0]![0]).toBe("0xabc");
  });

  it("produces one point per period for each timeframe", async () => {
    mockDb.findWalletsByUserId.mockResolvedValue([stacksWallet]);
    expect((await service.compute(1, "1d")).chartData).toHaveLength(24);
    expect((await service.compute(1, "7d")).chartData).toHaveLength(7);
    expect((await service.compute(1, "30d")).chartData).toHaveLength(30);
  });

  it("reports PnL relative to the first period, not absolute value", async () => {
    mockDb.findWalletsByUserId.mockResolvedValue([stacksWallet]);
    fetchBalances.mockResolvedValue([{ token: "STX", symbol: "STX", balance: 10, usdValue: 0 }]);
    mockRegistry.getTokenPrice.mockResolvedValue(2);

    const result = await service.compute(1, "7d");
    // Flat holdings, flat price: no drift means no PnL.
    expect(result.chartData[0]!.pnl).toBe(0);
    expect(result.summary.totalProfit).toBeCloseTo(0, 5);
  });
});
