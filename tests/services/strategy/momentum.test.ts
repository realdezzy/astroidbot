import { describe, it, expect, vi, beforeEach } from "vitest";
import { MomentumStrategy } from "../../../src/services/strategy/momentum.js";
import type { StrategyContext } from "../../../src/types/strategy.js";

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

describe("MomentumStrategy", () => {
  const strategy = new MomentumStrategy();

  const mockCtx: StrategyContext = {
    strategyId: 1,
    userId: 10,
    walletId: 2,
    address: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
    balances: [
      { token: "STX", symbol: "STX", balance: 500, usdValue: 1000 },
    ],
    tokens: [
      { contractId: "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx", symbol: "STX", name: "wstx", decimals: 6 },
      { contractId: "SP2D5B2763078GD93F62CABC0000000000000000.alex", symbol: "ALEX", name: "alex", decimals: 8 },
    ],
    settings: {
      slippageBps: 100,
      maxPositionPct: 25,
      dailyLossLimit: 10,
      rebalanceThreshold: 2,
    },
    config: {
      lookbackPeriods: 20,
      momentumThresholdPct: 2,
      positionSizeUsd: 50,
      tokenUniverse: "ALEX",
      exitThresholdPct: -1,
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockComputeMomentum.mockResolvedValue(0.0);
  });

  it("should trigger BUY signal when momentum is high and no position exists", async () => {
    mockComputeMomentum.mockResolvedValue(5.0); // momentum is +5.0% (> 2.0% threshold)
    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      tokenIn: "STX",
      tokenOut: "ALEX",
      amountIn: 50,
      direction: "BUY",
      slippageBps: 100,
      reason: "Momentum: ALEX +5.0%",
    });
  });

  it("should do nothing when momentum is high but position already exists", async () => {
    mockComputeMomentum.mockResolvedValue(5.0);
    const ctxWithBal = {
      ...mockCtx,
      balances: [
        { token: "STX", symbol: "STX", balance: 500, usdValue: 1000 },
        { token: "ALEX", symbol: "ALEX", balance: 100, usdValue: 50 },
      ],
    };
    const actions = await strategy.execute(ctxWithBal, {});
    expect(actions).toHaveLength(0);
  });

  it("should trigger SELL signal when momentum is negative and position exists", async () => {
    mockComputeMomentum.mockResolvedValue(-2.0); // momentum is -2.0% (< -1% exit threshold)
    const ctxWithBal = {
      ...mockCtx,
      balances: [
        { token: "STX", symbol: "STX", balance: 500, usdValue: 1000 },
        { token: "ALEX", symbol: "ALEX", balance: 100, usdValue: 50 },
      ],
    };
    const actions = await strategy.execute(ctxWithBal, {});
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      tokenIn: "ALEX",
      tokenOut: "STX",
      amountIn: 100, // Exits the full balance of ALEX
      direction: "SELL",
      slippageBps: 100,
      reason: "Momentum exit: ALEX -2.0%",
    });
  });
});
