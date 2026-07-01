import { describe, it, expect, vi, beforeEach } from "vitest";
import { TwapStrategy } from "../../../src/services/strategy/twap.js";
import { DatabaseService } from "../../../src/services/db.js";
import type { StrategyContext } from "../../../src/types/strategy.js";

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
vi.mock("../../../src/services/db.js", () => {
  return {
    DatabaseService: {
      getInstance: () => ({
        prisma: {
          trade: {
            findFirst: mockFindFirst,
            findMany: mockFindMany,
          },
        },
      }),
    },
  };
});

describe("TwapStrategy", () => {
  const strategy = new TwapStrategy();

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
      totalAmount: 100,
      slices: 10,
      windowMinutes: 60,
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockFindFirst.mockResolvedValue(null);
    mockFindMany.mockResolvedValue([]);
  });

  it("should trigger first slice of size totalAmount/slices", async () => {
    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      tokenIn: "STX",
      tokenOut: "sUSDT",
      amountIn: 10,
      direction: "BUY",
      reason: "TWAP slice: STX→sUSDT 10.0000",
    });
  });

  it("should not trigger if elapsed time is less than intervalMs", async () => {
    // 60 minutes window / 10 slices = 6 minutes slice interval = 360000 ms
    mockFindFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 2 * 60 * 1000), // 2 min ago
    });

    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(0);
  });

  it("should not trigger if all slices are completed", async () => {
    mockFindFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    mockFindMany.mockResolvedValue([
      { amountIn: 50 },
      { amountIn: 50 },
    ]);

    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(0);
  });

  it("should trigger a smaller remaining slice if partially filled", async () => {
    mockFindFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    mockFindMany.mockResolvedValue([
      { amountIn: 50 },
      { amountIn: 45 },
    ]); // 95 completed, 5 remaining (which is < slice size 10)

    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(1);
    expect(actions[0]!.amountIn).toBe(5);
  });
});
