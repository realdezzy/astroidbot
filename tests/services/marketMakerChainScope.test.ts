import { describe, it, expect, vi, beforeEach } from "vitest";

// The grid strategy hands the market maker its wallet's chain. Quoting and
// pricing the pair must stay on that chain: unscoped, a Base grid on ETH/USDC
// could take its mid from another network's same-ticker pool and place real
// orders around it.

const registry = {
  getTradingPairs: vi.fn(),
  getBestQuote: vi.fn(),
  getTokenPrice: vi.fn(),
};
vi.mock("../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: { getInstance: () => registry },
}));

const db = { findGridsByWallet: vi.fn(), upsertGrid: vi.fn() };
vi.mock("../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => db },
}));

vi.mock("../../src/services/ai.js", () => ({
  AIOrchestrator: { getInstance: () => ({ generateGridSpreads: vi.fn() }) },
}));

vi.mock("../../src/services/priceHistory.js", () => ({
  PriceHistoryService: { getInstance: () => ({ computeVolatility: vi.fn().mockResolvedValue(null) }) },
}));

vi.mock("../../src/services/tradeSettings.js", () => ({
  resolveTradeSettings: vi.fn().mockResolvedValue({ maxPositionPct: 25, slippageBps: 100 }),
}));

const { MarketMakerService } = await import("../../src/services/marketMaker.js");

describe("MarketMakerService chain scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registry.getBestQuote.mockResolvedValue({ providerName: "UniswapV3-base:mainnet", quote: { amountOut: 1 } });
    registry.getTokenPrice.mockImplementation(async (symbol: string) => (symbol === "ETH" ? 3000 : 1));
  });

  it("quotes and prices an existing grid on the wallet's chain", async () => {
    db.findGridsByWallet.mockResolvedValue([
      { tokenPair: "ETH/USDC", midPrice: 3000, gridLevels: 3, spreadBps: 50, lastUpdated: new Date() },
    ]);

    await MarketMakerService.getInstance().tick(10, 2, [{ symbol: "ETH", balance: 1, usdValue: 3000 }] as never, "base:mainnet");

    expect(registry.getBestQuote).toHaveBeenCalledWith("ETH", "USDC", 0.001, "base:mainnet");
    expect(registry.getTokenPrice).toHaveBeenCalledWith("ETH", "base:mainnet");
    expect(registry.getTokenPrice).toHaveBeenCalledWith("USDC", "base:mainnet");
  });

  it("seeds a first grid only from the wallet chain's pairs", async () => {
    db.findGridsByWallet.mockResolvedValue([]);
    registry.getTradingPairs.mockReturnValue([]);

    await MarketMakerService.getInstance().tick(10, 2, [], "base:mainnet");

    expect(registry.getTradingPairs).toHaveBeenCalledWith("base:mainnet");
  });
});
