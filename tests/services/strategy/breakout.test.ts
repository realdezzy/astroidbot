import { describe, it, expect, vi, beforeEach } from "vitest";
import { BreakoutStrategy } from "../../../src/services/strategy/breakout.js";
import { DatabaseService } from "../../../src/services/db.js";
import { PriceHistoryService } from "../../../src/services/priceHistory.js";
import type { StrategyContext, StrategyState } from "../../../src/types/strategy.js";

const mockGetHistory = vi.fn();
const mockComputeHigh = vi.fn();
const mockComputeLow = vi.fn();
vi.mock("../../../src/services/priceHistory.js", () => {
  return {
    PriceHistoryService: {
      getInstance: () => ({
        getHistory: mockGetHistory,
        computeHigh: mockComputeHigh,
        computeLow: mockComputeLow,
      }),
    },
  };
});

const mockFindFirst = vi.fn();
vi.mock("../../../src/services/db.js", () => {
  return {
    DatabaseService: {
      getInstance: () => ({
        prisma: {
          trade: {
            findFirst: mockFindFirst,
          },
        },
      }),
    },
  };
});

describe("BreakoutStrategy", () => {
  const strategy = new BreakoutStrategy();

  const mockCtx: StrategyContext = {
    strategyId: 1,
    userId: 10,
    walletId: 2,
    address: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
    balances: [],
    tokens: [],
    settings: {
      slippageBps: 100,
      maxPositionPct: 25,
      dailyLossLimit: 10,
      rebalanceThreshold: 2,
    },
    config: {
      lookbackPeriods: 20,
      breakoutPct: 3,
      tokenPair: "STX/sUSDT",
      positionSizeUsd: 10,
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetHistory.mockResolvedValue([2.0]);
    mockComputeHigh.mockResolvedValue(1.8); // 1.8 * 1.03 = 1.854. 2.0 is > 1.854 (breakout!)
    mockComputeLow.mockResolvedValue(1.5);
    mockFindFirst.mockResolvedValue(null);
  });

  it("should trigger BUY signal on crossover (breakout above high)", async () => {
    const state: StrategyState = {
      wasAboveHigh: false,
    };
    const actions = await strategy.execute(mockCtx, state);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      tokenIn: "STX",
      tokenOut: "sUSDT",
      amountIn: 10,
      direction: "BUY",
      reason: "Breakout: sUSDT crossed above 20-period high",
    });
    expect(state.wasAboveHigh).toBe(true);
  });

  it("should not trigger BUY if already above high in previous cycle", async () => {
    const state: StrategyState = {
      wasAboveHigh: true,
    };
    const actions = await strategy.execute(mockCtx, state);
    expect(actions).toHaveLength(0);
    expect(state.wasAboveHigh).toBe(true);
  });

  it("should trigger SELL signal on breakdown below low", async () => {
    mockGetHistory.mockResolvedValue([1.35]); // current price 1.35
    mockComputeHigh.mockResolvedValue(1.8);
    mockComputeLow.mockResolvedValue(1.5); // 1.5 * 0.97 = 1.455. 1.35 is < 1.455 (breakdown!)
    mockFindFirst.mockResolvedValue({ amountIn: 10 }); // owning position

    const state: StrategyState = {
      wasAboveLow: false,
    };
    const actions = await strategy.execute(mockCtx, state);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      tokenIn: "sUSDT",
      tokenOut: "STX",
      amountIn: 10,
      direction: "SELL",
      reason: "Breakdown: sUSDT crossed below 20-period low",
    });
    expect(state.wasAboveLow).toBe(true);
  });
});
