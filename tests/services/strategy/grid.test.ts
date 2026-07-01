import { describe, it, expect, vi, beforeEach } from "vitest";
import { GridStrategy } from "../../../src/services/strategy/grid.js";
import { MarketMakerService } from "../../../src/services/marketMaker.js";
import type { StrategyContext } from "../../../src/types/strategy.js";

const mockTick = vi.fn();
vi.mock("../../../src/services/marketMaker.js", () => {
  return {
    MarketMakerService: {
      getInstance: () => ({
        tick: mockTick,
      }),
    },
  };
});

describe("GridStrategy", () => {
  const strategy = new GridStrategy();

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
    config: {},
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockTick.mockResolvedValue([]);
  });

  it("should forward to MarketMakerService and return correct actions", async () => {
    const mockActions = [
      { tokenIn: "STX", tokenOut: "ALEX", amountIn: 20, direction: "BUY" as const, reason: "Grid placement" },
    ];
    mockTick.mockResolvedValue(mockActions);

    const actions = await strategy.execute(mockCtx, {});
    expect(mockTick).toHaveBeenCalledWith(10, 2, []);
    expect(actions).toEqual(mockActions);
  });

  it("should return empty array when MarketMakerService produces no grid actions", async () => {
    mockTick.mockResolvedValue([]);

    const actions = await strategy.execute(mockCtx, {});
    expect(mockTick).toHaveBeenCalledWith(10, 2, []);
    expect(actions).toEqual([]);
  });

  it("should propagate errors from MarketMakerService", async () => {
    mockTick.mockRejectedValue(new Error("Market maker unavailable"));

    await expect(strategy.execute(mockCtx, {}))
      .rejects.toThrow("Market maker unavailable");
  });
});
