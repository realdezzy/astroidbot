import { describe, it, expect, vi, beforeEach } from "vitest";
import { MeanReversionStrategy } from "../../../src/services/strategy/meanReversion.js";
import { PriceHistoryService } from "../../../src/services/priceHistory.js";
import { DatabaseService } from "../../../src/services/db.js";
import type { StrategyContext } from "../../../src/types/strategy.js";

const mockGetHistory = vi.fn();
const mockComputeMovingAverage = vi.fn();
vi.mock("../../../src/services/priceHistory.js", () => {
  return {
    PriceHistoryService: {
      getInstance: () => ({
        getHistory: mockGetHistory,
        computeMovingAverage: mockComputeMovingAverage,
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

describe("MeanReversionStrategy", () => {
  const strategy = new MeanReversionStrategy();

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
      maPeriods: 20,
      entryDeviationPct: 5,
      exitDeviationPct: 1,
      tokenPair: "STX/sUSDT",
      positionSizeUsd: 50,
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetHistory.mockResolvedValue([2.0]);
    mockComputeMovingAverage.mockResolvedValue(2.2); // price 2.0 is ~9.1% below MA 2.2
    mockFindFirst.mockResolvedValue(null);
  });

  it("should trigger BUY signal when deviation is below negative entry threshold and no position exists", async () => {
    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      tokenIn: "STX",
      tokenOut: "sUSDT",
      amountIn: 50,
      direction: "BUY",
      reason: "Mean reversion buy: sUSDT -9.1% below MA",
    });
  });

  it("should trigger SELL signal when deviation is above positive exit threshold and position exists", async () => {
    mockGetHistory.mockResolvedValue([2.5]);
    mockComputeMovingAverage.mockResolvedValue(2.2); // price 2.5 is ~13.6% above MA 2.2 (> 1% exit threshold)
    mockFindFirst.mockResolvedValue({
      id: 99,
      amountIn: 40,
    });

    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      tokenIn: "sUSDT",
      tokenOut: "STX",
      amountIn: 40,
      direction: "SELL",
      reason: "Mean reversion sell: sUSDT 13.6% above MA",
    });
  });
});
