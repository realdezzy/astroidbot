import { describe, it, expect, vi, beforeEach } from "vitest";
import { SniperStrategy } from "../../../src/services/strategy/sniper.js";
import { DatabaseService } from "../../../src/services/db.js";
import { DEXRegistry } from "../../../src/services/dex/dexRegistry.js";
import type { StrategyContext } from "../../../src/types/strategy.js";

const mockGetSwappableTokens = vi.fn();
const mockGetBestQuote = vi.fn();
vi.mock("../../../src/services/dex/dexRegistry.js", () => {
  return {
    DEXRegistry: {
      getInstance: () => ({
        getSwappableTokens: mockGetSwappableTokens,
        getBestQuote: mockGetBestQuote,
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

describe("SniperStrategy", () => {
  const strategy = new SniperStrategy();

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
      watchTokens: "ALEX,WELSH",
      maxBuyAmount: 1,
      perTokenCapUsd: 5,
      maxPriceImpactPct: 5,
      cooldownMinutes: 60,
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetSwappableTokens.mockResolvedValue([
      { symbol: "ALEX", contractId: "1" },
      { symbol: "WELSH", contractId: "2" },
    ]);
    mockFindFirst.mockResolvedValue(null);
    mockGetBestQuote.mockResolvedValue({
      quote: {
        amountOut: 100,
        priceImpact: 1.0,
      },
    });
  });

  it("should trigger sniper BUY actions for watchTokens when quote is valid and matches criteria", async () => {
    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(2);
    expect(actions[0]!.tokenOut).toBe("ALEX");
    expect(actions[1]!.tokenOut).toBe("WELSH");
    expect(actions[0]!.amountIn).toBe(1);
  });

  it("should skip token if priceImpact exceeds maxPriceImpactPct threshold", async () => {
    mockGetBestQuote.mockResolvedValue({
      quote: {
        amountOut: 100,
        priceImpact: 10.0, // 10% is greater than 5% limit
      },
    });
    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(0);
  });

  it("should respect cooldown gating constraints", async () => {
    mockFindFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago (< 60 minutes cooldown)
    });
    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(0);
  });
});
