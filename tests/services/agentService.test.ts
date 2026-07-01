import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { AgentService } from "../../src/services/agentService.js";
import { ConfigManager } from "../../src/config.js";
import { DatabaseService } from "../../src/services/db.js";
import { DEXRegistry } from "../../src/services/dex/dexRegistry.js";
import { AIOrchestrator } from "../../src/services/ai.js";
import { PortfolioManager } from "../../src/services/portfolio.js";
import { StrategyEngine } from "../../src/services/strategyEngine.js";

const mockDbInstance = {
  findWalletsByUserId: vi.fn(),
  updateWalletBalance: vi.fn(),
  findTradeSettings: vi.fn(),
  prisma: {
    tradeAgent: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    tradingStrategy: {
      findMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
};

const mockDexRegistryInstance = {
  getSwappableTokens: vi.fn(),
  getTokenPrice: vi.fn(),
};

const mockPortfolioManagerInstance = {
  fetchBalances: vi.fn(),
};

const mockStrategyEngineInstance = {
  runStrategies: vi.fn(),
};

const mockAiOrchestratorInstance = {
  request: vi.fn(),
  getTokenPrice: vi.fn(),
};

vi.mock("../../src/services/db.js", () => {
  return {
    DatabaseService: {
      getInstance: () => mockDbInstance,
    },
  };
});

vi.mock("../../src/services/dex/dexRegistry.js", () => {
  return {
    DEXRegistry: {
      getInstance: () => mockDexRegistryInstance,
    },
  };
});

vi.mock("../../src/services/portfolio.js", () => {
  return {
    PortfolioManager: {
      getInstance: () => mockPortfolioManagerInstance,
    },
  };
});

vi.mock("../../src/services/strategyEngine.js", () => {
  return {
    StrategyEngine: {
      getInstance: () => mockStrategyEngineInstance,
    },
    executeApprovedActions: vi.fn(),
  };
});

vi.mock("../../src/services/ai.js", () => {
  return {
    AIOrchestrator: {
      getInstance: () => mockAiOrchestratorInstance,
    },
  };
});

describe("AgentService Unit Tests", () => {
  beforeAll(() => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") {
      delete process.env.TELEGRAM_WEBHOOK_URL;
    }
    if (process.env.VELUMX_RELAYER_URL === "") {
      delete process.env.VELUMX_RELAYER_URL;
    }
    ConfigManager.load();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockDbInstance.prisma.tradeAgent.findUnique.mockResolvedValue({
      id: 1,
      userId: 10,
      name: "Auto Agent",
      isActive: true,
      aiMode: "autonomous",
      config: { maxPositionPct: 20 },
      state: {},
      failureCount: 0,
    });

    mockDbInstance.findWalletsByUserId.mockResolvedValue([
      { id: 2, address: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE", balance: 100 },
    ]);

    mockDexRegistryInstance.getSwappableTokens.mockResolvedValue([]);
    mockDexRegistryInstance.getTokenPrice.mockResolvedValue(2.0);
    mockPortfolioManagerInstance.fetchBalances.mockResolvedValue([
      { token: "STX", symbol: "STX", balance: 100, usdValue: 200 },
    ]);

    mockDbInstance.prisma.tradingStrategy.findMany.mockResolvedValue([]);
    mockStrategyEngineInstance.runStrategies.mockResolvedValue({ strategies: 0, actions: 0 });
    mockDbInstance.findTradeSettings.mockResolvedValue({ slippageBps: 100, maxPositionPct: 25, dailyLossLimit: 1000 });
  });

  it("should skip run if agent is inactive", async () => {
    mockDbInstance.prisma.tradeAgent.findUnique.mockResolvedValue({ id: 1, isActive: false });
    const result = await AgentService.getInstance().runAgentCycle(1);
    expect(result.reason).toBe("Agent not active");
  });

  it("should execute deterministic strategies and save new agent state", async () => {
    mockDbInstance.prisma.tradeAgent.findUnique.mockResolvedValue({
      id: 1,
      userId: 10,
      name: "Deterministic Agent",
      isActive: true,
      aiMode: "off",
      config: {},
      state: {},
      failureCount: 0,
    });
    mockDbInstance.prisma.tradingStrategy.findMany.mockResolvedValue([
      { id: 5, type: "dca", config: {}, userId: 10 },
    ]);
    mockStrategyEngineInstance.runStrategies.mockResolvedValue({ strategies: 1, actions: 1 });

    const result = await AgentService.getInstance().runAgentCycle(1);
    expect(result.strategiesExecuted).toBe(1);
    expect(result.actions).toBe(1);
    expect(mockDbInstance.prisma.tradeAgent.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        state: expect.objectContaining({
          lastStrategiesExecuted: 1,
          lastActions: 1,
        }),
      },
    });
  });

  it("should increment failure count and eventually disable agent on consecutive errors", async () => {
    mockDbInstance.prisma.tradeAgent.findUnique.mockResolvedValue({
      id: 1,
      userId: 10,
      name: "Failing Agent",
      isActive: true,
      failureCount: 4, // 5th failure will disable it
    });
    mockDbInstance.findWalletsByUserId.mockRejectedValue(new Error("Connection timeout"));

    await expect(AgentService.getInstance().runAgentCycle(1)).rejects.toThrow("Connection timeout");

    expect(mockDbInstance.prisma.tradeAgent.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        failureCount: 5,
        isActive: false,
      },
    });
  });

  it("should invoke AI overlay when aiMode is autonomous and enqueue the trade", async () => {
    mockDbInstance.prisma.tradeAgent.findUnique.mockResolvedValue({
      id: 1,
      userId: 10,
      name: "Auto Agent",
      isActive: true,
      aiMode: "autonomous",
      config: { maxPositionPct: 25 },
      state: {},
      failureCount: 0,
    });
    mockDbInstance.prisma.tradingStrategy.findMany.mockResolvedValue([]);
    mockStrategyEngineInstance.runStrategies.mockResolvedValue({ strategies: 0, actions: 0 });

    mockDbInstance.findWalletsByUserId.mockResolvedValue([
      { id: 5, address: "SP123", balance: 100 },
    ]);
    mockDexRegistryInstance.getTokenPrice.mockResolvedValue(1.5);

    // AI returns a trade decision
    mockAiOrchestratorInstance.request.mockResolvedValue({
      action: "trade",
      reason: "AI sees opportunity",
      trade: { walletId: 5, tokenIn: "STX", tokenOut: "sUSDT", amountIn: 10, direction: "BUY", reason: "bullish" },
    });

    // Mock trade execution to succeed
    const { executeApprovedActions: mockExec } = await import("../../src/services/strategyEngine.js");
    vi.mocked(mockExec).mockResolvedValue({ executed: 1 });

    const result = await AgentService.getInstance().runAgentCycle(1);
    expect(result.strategiesExecuted).toBe(0);
    expect(result.actions).toBe(1);
    expect(result.aiDecision).toBeDefined();
    expect(result.aiDecision!.action).toBe("trade");
    expect(mockDbInstance.prisma.tradeAgent.update).toHaveBeenCalled();
  });
});
