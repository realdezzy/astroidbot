import { describe, it, expect, vi, beforeEach } from "vitest";
import { RiskManager } from "../../src/services/riskManager.js";
import { DatabaseService } from "../../src/services/db.js";
import type { RebalanceAction, TokenBalance } from "../../src/types.js";

const mockGetDailyTradesSince = vi.fn();
vi.mock("../../src/services/db.js", () => {
  return {
    DatabaseService: {
      getInstance: () => ({
        getDailyTradesSince: mockGetDailyTradesSince,
      }),
    },
  };
});

describe("RiskManager unit tests", () => {
  const manager = RiskManager.getInstance();
  const settings = {
    slippageBps: 100,
    maxPositionPct: 25.0,
    dailyLossLimit: 50.0, // USD or relative limit depending on evaluation logic
  };

  const balances: TokenBalance[] = [
    { token: "STX", symbol: "STX", balance: 1000, usdValue: 2000 },
    { token: "sUSDT", symbol: "sUSDT", balance: 500, usdValue: 500 },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetDailyTradesSince.mockResolvedValue([]);
    manager.resetDailyLossReporting();
  });

  it("should fail validation if portfolio value is zero", async () => {
    const action: RebalanceAction = {
      tokenIn: "STX",
      tokenOut: "sUSDT",
      amountIn: 100,
      direction: "BUY",
      reason: "test",
    };
    const result = await manager.evaluateTrade(1, action, [], settings);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("Portfolio has no value");
  });

  it("should block buys that exceed max position percentage limit", async () => {
    const action: RebalanceAction = {
      tokenIn: "STX",
      tokenOut: "sUSDT",
      amountIn: 1000, // buying 1000 STX -> worth 2000 USD, which would exceed maxPositionPct (25%)
      direction: "BUY",
      reason: "test",
    };
    const result = await manager.evaluateTrade(1, action, balances, settings);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Would exceed max position for sUSDT");
  });

  it("should block sell trades that exceed 50% of current token position size", async () => {
    const action: RebalanceAction = {
      tokenIn: "STX",
      tokenOut: "sUSDT",
      amountIn: 600, // selling 600 STX out of 1000 STX (60%)
      direction: "SELL",
      reason: "test",
    };
    const result = await manager.evaluateTrade(1, action, balances, settings);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Sell exceeds 50% of STX position");
  });

  it("should fail validation for SELL if balance is insufficient", async () => {
    const action: RebalanceAction = {
      tokenIn: "STX",
      tokenOut: "sUSDT",
      amountIn: 2000, // exceeds 1000 STX balance
      direction: "SELL",
      reason: "test",
    };
    const result = await manager.evaluateTrade(1, action, balances, settings);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Insufficient STX balance for sell");
  });

  it("should block validation when daily loss limit has been breached", async () => {
    // Mock daily trades representing a total loss larger than dailyLossLimit settings
    mockGetDailyTradesSince.mockResolvedValue([
      {
        id: 1,
        status: "CONFIRMED",
        direction: "BUY",
        amountIn: 100, // buying STX, counted as -100 PnL
        amountOut: 0,
      },
    ]);

    const action: RebalanceAction = {
      tokenIn: "STX",
      tokenOut: "sUSDT",
      amountIn: 10,
      direction: "BUY",
      reason: "test",
    };

    const strictSettings = {
      slippageBps: 100,
      maxPositionPct: 25.0,
      dailyLossLimit: 10.0, // setting lower daily loss limit
    };

    const result = await manager.evaluateTrade(1, action, balances, strictSettings);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Daily loss limit reached");
  });

  it("should process evaluateActions and return correct approved/rejected splits", async () => {
    const actions: RebalanceAction[] = [
      {
        tokenIn: "STX",
        tokenOut: "sUSDT",
        amountIn: 10,
        direction: "BUY",
        reason: "Valid buy",
      },
      {
        tokenIn: "STX",
        tokenOut: "sUSDT",
        amountIn: 2000, // Insufficient balance
        direction: "SELL",
        reason: "Invalid sell",
      },
    ];

    const result = await manager.evaluateActions(1, actions, balances, settings);
    expect(result.approved).toHaveLength(1);
    expect(result.approved[0]!.reason).toBe("Valid buy");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toContain("Insufficient STX balance for sell");
  });
});
