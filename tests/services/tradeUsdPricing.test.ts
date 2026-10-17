import { describe, it, expect, vi, beforeEach } from "vitest";

// A confirmed trade without recorded USD values is priced at confirmation.
// Those figures feed the daily-loss limit, so they must be priced on the
// trade's own chain and recognise that chain's stablecoin — this path used to
// do neither, valuing a Base trade off whichever provider answered first and
// its USDC leg at zero when that provider had no price.

const getTokenPrice = vi.fn();
vi.mock("../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: { getInstance: () => ({ getTokenPrice }) },
}));

const { DatabaseService } = await import("../../src/services/db.js");

const prisma = {
  trade: { findUnique: vi.fn(), update: vi.fn() },
};

// Built from the prototype so no PrismaClient or config is needed; the stub
// above stands in for the client.
const db = Object.assign(Object.create(DatabaseService.prototype), { prisma }) as InstanceType<typeof DatabaseService>;

describe("DatabaseService.updateTradeStatus USD pricing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.trade.update.mockResolvedValue({});
  });

  it("prices both legs on the trade's recorded chain", async () => {
    prisma.trade.findUnique.mockResolvedValue({
      id: 1, chain: "base:mainnet", tokenIn: "USDC", tokenOut: "ETH", amountIn: 100, amountOut: 0.03,
      amountInUsd: null, amountOutUsd: null, wallet: { chain: "base:mainnet", chainFamily: "evm" },
    });
    getTokenPrice.mockImplementation(async (symbol: string) => (symbol === "ETH" ? 3000 : null));

    await db.updateTradeStatus(1, "CONFIRMED", "0xtx");

    expect(getTokenPrice).toHaveBeenCalledWith("USDC", "base:mainnet");
    expect(getTokenPrice).toHaveBeenCalledWith("ETH", "base:mainnet");
    const data = prisma.trade.update.mock.calls[0]![0].data;
    // Unpriced USDC is still a dollar; it used to be valued at zero off-Stacks.
    expect(data.amountInUsd).toBe(100);
    expect(data.amountOutUsd).toBeCloseTo(90);
  });

  it("falls back to the wallet's chain for a trade row without one", async () => {
    prisma.trade.findUnique.mockResolvedValue({
      id: 2, chain: null, tokenIn: "SOL", tokenOut: "USDC", amountIn: 1, amountOut: 150,
      amountInUsd: null, amountOutUsd: null, wallet: { chain: "solana:mainnet", chainFamily: "svm" },
    });
    getTokenPrice.mockResolvedValue(150);

    await db.updateTradeStatus(2, "CONFIRMED", "sig");

    expect(getTokenPrice).toHaveBeenCalledWith("SOL", "solana:mainnet");
  });
});
