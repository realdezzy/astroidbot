import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A triggered limit order is a trade, and every trade goes through RiskManager.
 *
 * `checkAndExecute` built a payload and called `executeSwapPayload` directly,
 * with no risk evaluation anywhere in the file. So `maxPositionPct` and
 * `dailyLossLimit` — the two limits a user sets to bound their exposure —
 * applied to trades placed from the web, the bot and the queue, but not to the
 * one kind of trade that fires while nobody is watching.
 *
 * It also fetched the user's resolved settings and read exactly one field off
 * them (`useGasless`), hardcoding slippage as `est.amountOut * 0.99`. The
 * product default for `slippageBps` is 100 — 1% — so the hardcode agreed with
 * the default and disagreed with every user who had changed it. Someone who
 * tightened to 0.1% to avoid being sandwiched got 1% anyway.
 */

const createTrade = vi.fn();
const updateTradeStatus = vi.fn();
const limitOrderUpdate = vi.fn();
const limitOrderFindMany = vi.fn();

vi.mock("../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({
      createTrade,
      updateTradeStatus,
      findWalletById: vi.fn(),
      prisma: {
        limitOrder: { findMany: limitOrderFindMany, update: limitOrderUpdate },
        trade: { findMany: vi.fn().mockResolvedValue([]) },
      },
    }),
  },
}));

const buildSwapPayload = vi.fn();
const getBestQuote = vi.fn();

vi.mock("../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: {
    getInstance: () => ({
      getBestQuote,
      getSwappableTokens: vi.fn().mockResolvedValue([]),
      getProvider: () => ({ buildSwapPayload }),
    }),
  },
}));

const executeSwapPayload = vi.fn();
vi.mock("../../src/services/chains/executeSwap.js", () => ({ executeSwapPayload }));

vi.mock("../../src/services/chains/walletChain.js", () => ({
  walletChainId: () => "base:mainnet",
  walletStableSymbol: () => "USDC",
}));

const evaluateTrade = vi.fn();
vi.mock("../../src/services/riskManager.js", () => ({
  RiskManager: { getInstance: () => ({ evaluateTrade }) },
}));

const resolveTradeSettings = vi.fn();
vi.mock("../../src/services/tradeSettings.js", () => ({ resolveTradeSettings }));

vi.mock("../../src/services/marketData/index.js", () => ({
  resolveMarketDataProvider: () => ({
    supportsChain: () => true,
    getMarketData: async () => new Map([["tkn", { priceUsd: 1 }]]),
  }),
}));

vi.mock("../../src/services/portfolio.js", () => ({
  PortfolioManager: {
    getInstance: () => ({
      fetchBalances: vi.fn().mockResolvedValue([
        { token: "USDC", symbol: "USDC", balance: 1_000, usdValue: 1_000 },
      ]),
    }),
  },
}));

vi.mock("../../src/api/websocket.js", () => ({
  WebSocketManager: { getInstance: () => ({ broadcastTradeEvent: vi.fn() }) },
}));

vi.mock("../../src/services/notificationService.js", () => ({
  NotificationService: { send: vi.fn() },
}));

const { LimitOrderService } = await import("../../src/services/limitOrder.js");

const WALLET = {
  id: 7,
  userId: 1,
  address: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
  chain: "base:mainnet",
  chainFamily: "evm",
};

/** An order already past `forceAfter`, so the trigger fires without a price. */
function triggeredOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    userId: 1,
    walletId: 7,
    tokenIn: "USDC",
    tokenOut: "TKN",
    direction: "BUY",
    targetPrice: 1,
    amountIn: 100,
    status: "ACTIVE",
    forceAfter: new Date(Date.now() - 60_000),
    expiresAt: null,
    ...overrides,
  };
}

describe("limit order risk enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitOrderFindMany.mockResolvedValue([triggeredOrder()]);
    getBestQuote.mockResolvedValue({
      providerName: "UniswapV3-base:mainnet",
      quote: { amountOut: 1_000, feeAmount: 1, feeBps: 30 },
    });
    buildSwapPayload.mockResolvedValue({ kind: "evm", calls: [{ to: "0x0", data: "0x" }] });
    executeSwapPayload.mockResolvedValue({ txId: "0xdead" });
    createTrade.mockResolvedValue({ id: 99 });
    resolveTradeSettings.mockResolvedValue({
      slippageBps: 100,
      maxPositionPct: 25,
      dailyLossLimit: 5,
      useGasless: false,
    });
    evaluateTrade.mockResolvedValue({ approved: true });
  });

  it("evaluates the trade against the user's risk limits", async () => {
    await LimitOrderService.getInstance().checkAndExecute([WALLET], []);
    expect(evaluateTrade).toHaveBeenCalledTimes(1);
  });

  it("passes the user's configured limits, not defaults", async () => {
    resolveTradeSettings.mockResolvedValue({
      slippageBps: 250,
      maxPositionPct: 10,
      dailyLossLimit: 2,
      useGasless: false,
    });

    await LimitOrderService.getInstance().checkAndExecute([WALLET], []);

    expect(evaluateTrade).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ tokenIn: "USDC", tokenOut: "TKN", amountIn: 100 }),
      expect.any(Array),
      { slippageBps: 250, maxPositionPct: 10, dailyLossLimit: 2 }
    );
  });

  it("does not broadcast when risk declines the trade", async () => {
    evaluateTrade.mockResolvedValue({ approved: false, reason: "Position too large" });

    const result = await LimitOrderService.getInstance().checkAndExecute([WALLET], []);

    expect(executeSwapPayload).not.toHaveBeenCalled();
    expect(createTrade).not.toHaveBeenCalled();
    expect(result.executed).toBe(0);
  });

  it("evaluates risk before building the payload, not after", async () => {
    // Order matters for more than tidiness: building a payload runs quotes and
    // allowance reads against the chain, and a declined trade should not spend
    // them.
    const calls: string[] = [];
    evaluateTrade.mockImplementation(async () => {
      calls.push("risk");
      return { approved: false, reason: "no" };
    });
    buildSwapPayload.mockImplementation(async () => {
      calls.push("build");
      return { kind: "evm", calls: [] };
    });

    await LimitOrderService.getInstance().checkAndExecute([WALLET], []);

    expect(calls).toEqual(["risk"]);
  });

  it("derives minOut from the user's slippage setting", async () => {
    // 250 bps on an expected 1,000 out is 975, not the hardcoded 990.
    resolveTradeSettings.mockResolvedValue({
      slippageBps: 250,
      maxPositionPct: 25,
      dailyLossLimit: 5,
      useGasless: false,
    });

    await LimitOrderService.getInstance().checkAndExecute([WALLET], []);

    expect(buildSwapPayload).toHaveBeenCalledWith("USDC", "TKN", 100, 975, WALLET.address);
  });

  it("still honours a tightened slippage setting", async () => {
    // 10 bps — someone deliberately avoiding a sandwich. The old hardcode gave
    // them 100 bps of room they did not ask for.
    resolveTradeSettings.mockResolvedValue({
      slippageBps: 10,
      maxPositionPct: 25,
      dailyLossLimit: 5,
      useGasless: false,
    });

    await LimitOrderService.getInstance().checkAndExecute([WALLET], []);

    expect(buildSwapPayload).toHaveBeenCalledWith("USDC", "TKN", 100, 999, WALLET.address);
  });
});
