import { describe, it, expect, vi, beforeEach } from "vitest";
import { PortfolioRebalanceStrategy } from "../../../src/services/strategy/portfolioRebalance.js";
import { DatabaseService } from "../../../src/services/db.js";
import { AIOrchestrator } from "../../../src/services/ai.js";
import { PortfolioManager } from "../../../src/services/portfolio.js";
import { RiskManager } from "../../../src/services/riskManager.js";
import { PriceHistoryService } from "../../../src/services/priceHistory.js";
import type { StrategyContext, StrategyState } from "../../../src/types/strategy.js";

const mockUpdate = vi.fn();
vi.mock("../../../src/services/db.js", () => {
  return {
    DatabaseService: {
      getInstance: () => ({
        prisma: {
          tradingStrategy: {
            update: mockUpdate,
          },
        },
      }),
    },
  };
});

const mockAnalyzeSentiment = vi.fn();
const mockGeneratePortfolioTargets = vi.fn();
vi.mock("../../../src/services/ai.js", () => {
  return {
    AIOrchestrator: {
      getInstance: () => ({
        analyzeSentiment: mockAnalyzeSentiment,
        generatePortfolioTargets: mockGeneratePortfolioTargets,
      }),
    },
  };
});

const mockComputeRebalanceActions = vi.fn();
vi.mock("../../../src/services/portfolio.js", () => {
  return {
    PortfolioManager: {
      getInstance: () => ({
        computeRebalanceActions: mockComputeRebalanceActions,
      }),
    },
  };
});

const mockEvaluateActions = vi.fn();
vi.mock("../../../src/services/riskManager.js", () => {
  return {
    RiskManager: {
      getInstance: () => ({
        evaluateActions: mockEvaluateActions,
      }),
    },
  };
});

const mockGetHistory = vi.fn();
vi.mock("../../../src/services/priceHistory.js", () => {
  return {
    PriceHistoryService: {
      getInstance: () => ({
        getHistory: mockGetHistory,
      }),
    },
  };
});

describe("PortfolioRebalanceStrategy", () => {
  const strategy = new PortfolioRebalanceStrategy();

  const mockCtx: StrategyContext = {
    strategyId: 1,
    userId: 10,
    walletId: 2,
    address: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
    balances: [
      { token: "STX", symbol: "STX", balance: 500, usdValue: 1000 },
      { token: "ALEX", symbol: "ALEX", balance: 100, usdValue: 50 },
    ],
    tokens: [],
    settings: {
      slippageBps: 100,
      maxPositionPct: 25,
      dailyLossLimit: 10,
      rebalanceThreshold: 2,
    },
    config: {
      useAI: true,
      aiRefreshMinutes: 15,
      minTradeUsd: 5,
      rebalanceThreshold: 2,
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetHistory.mockResolvedValue([1.0, 1.2]);
    mockAnalyzeSentiment.mockResolvedValue({ ALEX: "bullish" });
    mockGeneratePortfolioTargets.mockResolvedValue([
      { token: "STX", targetWeight: 0.6 },
      { token: "ALEX", targetWeight: 0.4 },
    ]);
    mockComputeRebalanceActions.mockReturnValue([
      { tokenIn: "STX", tokenOut: "ALEX", amountIn: 10, direction: "BUY" },
    ]);
    mockEvaluateActions.mockResolvedValue({
      approved: [{ tokenIn: "STX", tokenOut: "ALEX", amountIn: 10, direction: "BUY" }],
      rejected: [],
    });
  });

  it("should refresh portfolio targets via AI if cache is empty or expired", async () => {
    const state: StrategyState = {};
    const actions = await strategy.execute(mockCtx, state);

    expect(mockAnalyzeSentiment).toHaveBeenCalled();
    expect(mockGeneratePortfolioTargets).toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        state: expect.objectContaining({
          cachedTargets: expect.any(Array),
          lastAiRefresh: expect.any(Number),
        }),
      },
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.tokenOut).toBe("ALEX");
  });

  it("should use cached targets if AI refresh window is not yet expired", async () => {
    const state: StrategyState = {
      lastAiRefresh: Date.now() - 5 * 60 * 1000, // 5 min ago (< 15 min refresh threshold)
      cachedTargets: [
        { token: "STX", targetWeight: 0.6 },
        { token: "ALEX", targetWeight: 0.4 },
      ],
    };

    const actions = await strategy.execute(mockCtx, state);

    expect(mockAnalyzeSentiment).not.toHaveBeenCalled();
    expect(mockGeneratePortfolioTargets).not.toHaveBeenCalled();
    expect(actions).toHaveLength(1);
  });
});
