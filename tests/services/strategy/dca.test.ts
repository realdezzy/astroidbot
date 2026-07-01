import { describe, it, expect, vi, beforeEach } from "vitest";
import { DCAStrategy } from "../../../src/services/strategy/dca.js";
import { DatabaseService } from "../../../src/services/db.js";
import { AlexDEXService } from "../../../src/services/dex/alex.js";
import type { StrategyContext } from "../../../src/types/strategy.js";

const mockFindMany = vi.fn();
const mockFindFirst = vi.fn();
vi.mock("../../../src/services/db.js", () => {
  return {
    DatabaseService: {
      getInstance: () => ({
        prisma: {
          trade: {
            findMany: mockFindMany,
            findFirst: mockFindFirst,
          },
        },
      }),
    },
  };
});

const mockGetTokenPrice = vi.fn();
vi.mock("../../../src/services/dex/alex.js", () => {
  return {
    AlexDEXService: {
      getInstance: () => ({
        getTokenPrice: mockGetTokenPrice,
      }),
    },
  };
});

describe("DCAStrategy", () => {
  const strategy = new DCAStrategy();

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
      tokenIn: "STX",
      tokenOut: "sUSDT",
      amount: 10,
      intervalMinutes: 60,
      priceCondition: "always",
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockFindMany.mockResolvedValue([]);
    mockFindFirst.mockResolvedValue(null);
    mockGetTokenPrice.mockResolvedValue(2.0);
  });

  it("should trigger a buy when no trades exist yet", async () => {
    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      tokenIn: "STX",
      tokenOut: "sUSDT",
      amountIn: 10,
      direction: "BUY",
      reason: "DCA: STX→sUSDT 10 every 60min",
    });
  });

  it("should respect intervalMinutes constraints", async () => {
    // mock a recent trade within 10 minutes (intervalMinutes is 60)
    mockFindFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(0);
  });

  it("should trigger buy when interval elapsed is exceeded", async () => {
    mockFindFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 70 * 60 * 1000),
    });

    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(1);
  });

  it("should enforce priceCondition triggers correctly (below)", async () => {
    const customCtx = {
      ...mockCtx,
      config: {
        ...mockCtx.config,
        priceCondition: "below",
        priceThresholdUsd: 1.5,
      },
    };

    // price (2.0) is not below 1.5
    const actions1 = await strategy.execute(customCtx, {});
    expect(actions1).toHaveLength(0);

    // price (1.2) is below 1.5
    mockGetTokenPrice.mockResolvedValue(1.2);
    const actions2 = await strategy.execute(customCtx, {});
    expect(actions2).toHaveLength(1);
  });
});
