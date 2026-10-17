import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StrategyContext } from "../../../src/types/strategy.js";

// Strategies run per (strategy, wallet), and the wallet's chain is on the
// context. Every token default and every registry lookup must come from that
// chain: a Base wallet that falls back to "STX", or is priced by whichever
// provider answers first, produces orders that cannot route or are sized off
// another network's market.

const registry = {
  getSwappableTokens: vi.fn(),
  getTokenPrice: vi.fn(),
  getBestQuote: vi.fn(),
};
vi.mock("../../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: { getInstance: () => registry },
}));

const prisma = { trade: { findFirst: vi.fn(), findMany: vi.fn() } };
vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => ({ prisma }) },
}));

const priceHistory = { computeMomentum: vi.fn() };
vi.mock("../../../src/services/priceHistory.js", () => ({
  PriceHistoryService: { getInstance: () => priceHistory },
}));

const axiosGet = vi.fn();
vi.mock("axios", () => ({ default: { get: axiosGet } }));

// Copy reads its API URL from config; stubbed so an ungated copy strategy
// would reach the fetch below rather than fail early on unloaded config.
vi.mock("../../../src/config.js", () => ({
  ConfigManager: { getInstance: () => ({ config: { STACKS_API_URL: "https://api.hiro.so" } }) },
}));

const { SniperStrategy } = await import("../../../src/services/strategy/sniper.js");
const { DCAStrategy } = await import("../../../src/services/strategy/dca.js");
const { MomentumStrategy } = await import("../../../src/services/strategy/momentum.js");
const { CopyStrategy } = await import("../../../src/services/strategy/copy.js");

function baseCtx(config: Record<string, unknown>, overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    strategyId: 1,
    userId: 10,
    walletId: 2,
    address: "0x000000000000000000000000000000000000dEaD",
    chainId: "base:mainnet",
    balances: [],
    tokens: [],
    settings: { slippageBps: 100, maxPositionPct: 25, dailyLossLimit: 10, rebalanceThreshold: 2 },
    config,
    ...overrides,
  };
}

describe("strategy chain scoping", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prisma.trade.findFirst.mockResolvedValue(null);
    prisma.trade.findMany.mockResolvedValue([]);
  });

  it("sniper on Base pays in ETH and scopes every lookup to base:mainnet", async () => {
    registry.getSwappableTokens.mockResolvedValue([{ symbol: "DEGEN", contractId: "0xdegen" }]);
    registry.getTokenPrice.mockResolvedValue(0.01);
    registry.getBestQuote.mockResolvedValue({ quote: { amountOut: 100, priceImpact: 1 } });

    const actions = await new SniperStrategy().execute(
      baseCtx({ watchTokens: "DEGEN", maxBuyAmount: 1, perTokenCapUsd: 5, maxBuyPriceUsd: 1 }),
      {},
    );

    expect(registry.getSwappableTokens).toHaveBeenCalledWith(false, "base:mainnet");
    expect(registry.getTokenPrice).toHaveBeenCalledWith("DEGEN", "base:mainnet");
    expect(registry.getBestQuote).toHaveBeenCalledWith("ETH", "DEGEN", 1, "base:mainnet");
    expect(actions).toHaveLength(1);
    expect(actions[0]!.tokenIn).toBe("ETH");
  });

  it("DCA with no tokens configured defaults to the wallet chain's native and stable", async () => {
    const actions = await new DCAStrategy().execute(baseCtx({ amount: 5, intervalMinutes: 60 }), {});

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ tokenIn: "ETH", tokenOut: "USDC" });
  });

  it("DCA price conditions are evaluated on the wallet's chain", async () => {
    registry.getTokenPrice.mockResolvedValue(0.5);

    await new DCAStrategy().execute(
      baseCtx({ tokenIn: "ETH", tokenOut: "AERO", amount: 1, priceCondition: "below", priceThresholdUsd: 1 }),
      {},
    );

    expect(registry.getTokenPrice).toHaveBeenCalledWith("AERO", "base:mainnet");
  });

  it("momentum trades against the chain's native asset, not STX", async () => {
    priceHistory.computeMomentum.mockResolvedValue(10);

    const actions = await new MomentumStrategy().execute(
      baseCtx({ momentumThresholdPct: 2 }, { tokens: [{ symbol: "AERO", contractId: "0xaero", decimals: 18, name: "AERO" }] }),
      {},
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ tokenIn: "ETH", tokenOut: "AERO", direction: "BUY" });
  });

  it("copy-trading does nothing for a non-Stacks wallet", async () => {
    axiosGet.mockResolvedValue({ data: { results: [] } });
    const actions = await new CopyStrategy().execute(
      baseCtx({ targetAddress: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE" }),
      {},
    );

    expect(actions).toEqual([]);
    expect(axiosGet).not.toHaveBeenCalled();
  });
});
