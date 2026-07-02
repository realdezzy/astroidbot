import { describe, it, expect, vi, beforeEach } from "vitest";
import { StopLossTpStrategy } from "../../../src/services/strategy/stopLossTp.js";
import { DatabaseService } from "../../../src/services/db.js";
import { PriceHistoryService } from "../../../src/services/priceHistory.js";
import { DEXRegistry } from "../../../src/services/dex/dexRegistry.js";
import type { StrategyContext } from "../../../src/types/strategy.js";

const mockFindMany = vi.fn();
vi.mock("../../../src/services/db.js", () => {
  return {
    DatabaseService: {
      getInstance: () => ({
        prisma: {
          trade: {
            findMany: mockFindMany,
          },
        },
      }),
    },
  };
});

const mockComputeHigh = vi.fn();
vi.mock("../../../src/services/priceHistory.js", () => {
  return {
    PriceHistoryService: {
      getInstance: () => ({
        computeHigh: mockComputeHigh,
      }),
    },
  };
});

const mockGetTokenPrice = vi.fn();
vi.mock("../../../src/services/dex/dexRegistry.js", () => {
  return {
    DEXRegistry: {
      getInstance: () => ({
        getTokenPrice: mockGetTokenPrice,
      }),
    },
  };
});

describe("StopLossTpStrategy", () => {
  const strategy = new StopLossTpStrategy();

  const mockCtx: StrategyContext = {
    strategyId: 1,
    userId: 10,
    walletId: 2,
    address: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
    balances: [
      { token: "ALEX", symbol: "ALEX", balance: 100, usdValue: 200 }, // price = 2.0
    ],
    tokens: [],
    settings: {
      slippageBps: 100,
      maxPositionPct: 25,
      dailyLossLimit: 10,
      rebalanceThreshold: 2,
    },
    config: {
      token: "ALEX",
      takeProfitPct: 10,
      stopLossPct: 5,
      trailingStopPct: 0,
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockFindMany.mockResolvedValue([]);
    mockComputeHigh.mockResolvedValue(0);
    mockGetTokenPrice.mockResolvedValue(2.0);
  });

  it("should do nothing if token has no balance", async () => {
    const emptyCtx = {
      ...mockCtx,
      balances: [],
    };
    const actions = await strategy.execute(emptyCtx, {});
    expect(actions).toHaveLength(0);
  });

  it("should trigger take profit if price rises above target", async () => {
    // Buy cost: 150 STX for 100 ALEX -> average cost = 1.50. Current price = 2.0 (+33.3%)
    mockFindMany.mockResolvedValue([
      { amountIn: 150, amountOut: 100 },
    ]);

    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      tokenIn: "ALEX",
      tokenOut: "STX",
      amountIn: 100,
      direction: "SELL",
      slippageBps: 100,
      reason: "Take profit: ALEX 33.3% (WAC entry)",
    });
  });

  it("should trigger stop loss if price falls below threshold", async () => {
    // Buy cost: 250 STX for 100 ALEX -> average cost = 2.50. Current price = 2.0 (-20.0%)
    mockFindMany.mockResolvedValue([
      { amountIn: 250, amountOut: 100 },
    ]);

    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      tokenIn: "ALEX",
      tokenOut: "STX",
      amountIn: 100,
      direction: "SELL",
      slippageBps: 100,
      reason: "Stop loss: ALEX -20.0% (WAC entry)",
    });
  });

  it("should trigger trailing stop loss when price drops from historical high", async () => {
    const trailingCtx = {
      ...mockCtx,
      config: {
        ...mockCtx.config,
        takeProfitPct: 50,
        stopLossPct: 50,
        trailingStopPct: 5,
      },
    };

    // Buy cost: 180 STX for 100 ALEX -> average cost = 1.80. Current price = 2.0 (+11.1%)
    mockFindMany.mockResolvedValue([
      { amountIn: 180, amountOut: 100 },
    ]);
    mockComputeHigh.mockResolvedValue(2.2); // high was 2.2, drop to 2.0 is ~9.1% drop (> 5% trailingSl)

    const actions = await strategy.execute(trailingCtx, {});
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      tokenIn: "ALEX",
      tokenOut: "STX",
      amountIn: 100,
      direction: "SELL",
      slippageBps: 100,
      reason: "Trailing stop: ALEX -9.1% from high",
    });
  });
});
