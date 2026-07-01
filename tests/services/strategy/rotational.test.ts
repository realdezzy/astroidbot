import { describe, it, expect, vi, beforeEach } from "vitest";
import { RotationalStrategy } from "../../../src/services/strategy/rotational.js";
import { DatabaseService } from "../../../src/services/db.js";
import { PriceHistoryService } from "../../../src/services/priceHistory.js";
import type { StrategyContext } from "../../../src/types/strategy.js";

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

const mockComputeMomentum = vi.fn();
vi.mock("../../../src/services/priceHistory.js", () => {
  return {
    PriceHistoryService: {
      getInstance: () => ({
        computeMomentum: mockComputeMomentum,
      }),
    },
  };
});

describe("RotationalStrategy", () => {
  const strategy = new RotationalStrategy();

  const mockCtx: StrategyContext = {
    strategyId: 1,
    userId: 10,
    walletId: 2,
    address: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
    balances: [],
    tokens: [
      { contractId: "1", symbol: "STX", name: "STX", decimals: 6 },
      { contractId: "2", symbol: "ALEX", name: "ALEX", decimals: 8 },
      { contractId: "3", symbol: "DIKO", name: "DIKO", decimals: 8 },
      { contractId: "4", symbol: "WELSH", name: "WELSH", decimals: 6 },
    ],
    settings: {
      slippageBps: 100,
      maxPositionPct: 25,
      dailyLossLimit: 10,
      rebalanceThreshold: 2,
    },
    config: {
      topK: 2,
      rebalancePeriodHours: 24,
      positionSizeUsd: 10,
      tokenUniverse: "ALEX,DIKO,WELSH",
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockFindFirst.mockResolvedValue(null);
    mockComputeMomentum.mockImplementation((symbol) => {
      if (symbol === "ALEX") return 10.0;
      if (symbol === "DIKO") return 5.0;
      if (symbol === "WELSH") return -2.0;
      return 0.0;
    });
  });

  it("should trigger rotational buys for top-K momentum tokens when not owned", async () => {
    const actions = await strategy.execute(mockCtx, {});
    // Top-K (2) momentum tokens are ALEX (10.0) and DIKO (5.0). WELSH (-2.0) is not in top 2.
    // Since none are owned, it should buy ALEX and DIKO.
    expect(actions).toHaveLength(2);
    expect(actions.map(a => a.tokenOut)).toContain("ALEX");
    expect(actions.map(a => a.tokenOut)).toContain("DIKO");
    expect(actions.filter(a => a.direction === "BUY")).toHaveLength(2);
  });

  it("should rotate out of lower scored tokens and into higher scored tokens", async () => {
    // Mock that we already own DIKO and WELSH (WELSH is now lower scored)
    mockFindFirst.mockImplementation(({ where }) => {
      if (where.tokenOut === "WELSH") {
        return Promise.resolve({ amountIn: 10 });
      }
      if (where.tokenOut === "DIKO") {
        return Promise.resolve({ amountIn: 10 });
      }
      return Promise.resolve(null); // not owning ALEX
    });

    const actions = await strategy.execute(mockCtx, {});
    // Should sell WELSH (to rotate out) and buy ALEX (top-performing not yet owned)
    expect(actions).toHaveLength(2);
    const sellAction = actions.find(a => a.direction === "SELL");
    const buyAction = actions.find(a => a.direction === "BUY");
    expect(sellAction!.tokenIn).toBe("WELSH");
    expect(buyAction!.tokenOut).toBe("ALEX");
  });

  it("should respect rebalancePeriodHours gating", async () => {
    // Mock that a trade occurred 5 hours ago (rebalancePeriodHours is 24)
    mockFindFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 5 * 3600000),
    });

    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(0);
  });
});
