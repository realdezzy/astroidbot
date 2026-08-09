import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A limit order belongs to exactly one chain, and the route check has to be
 * asked on that chain.
 *
 * Unscoped, `getBestQuote` asked every registered provider, so a Base wallet's
 * STX→USDCx order passed validation because a Stacks router answered. The order
 * was persisted, could never route at execution time, and its price trigger
 * read 0 — so it sat there until `forceAfter` fired it into a failure. The web
 * form made this easy to hit: it let you tick wallets on different chains and
 * submitted one pair for all of them.
 */

const findWalletById = vi.fn();
const limitOrderCreate = vi.fn();

vi.mock("../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({
      findWalletById,
      prisma: {
        limitOrder: { findMany: vi.fn().mockResolvedValue([]), create: limitOrderCreate },
        trade: { findMany: vi.fn().mockResolvedValue([]) },
      },
    }),
  },
}));

const getBestQuote = vi.fn();
const getSwappableTokens = vi.fn().mockResolvedValue([]);

vi.mock("../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: {
    getInstance: () => ({ getBestQuote, getSwappableTokens }),
  },
}));

vi.mock("../../src/services/portfolio.js", () => ({
  PortfolioManager: {
    getInstance: () => ({
      fetchBalances: vi.fn().mockResolvedValue([
        { token: "STX", symbol: "STX", balance: 1_000, usdValue: 2_000 },
      ]),
    }),
  },
}));

const { LimitOrderService } = await import("../../src/services/limitOrder.js");

const BASE_WALLET = {
  id: 7,
  userId: 1,
  address: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
  chain: "base:mainnet",
  chainFamily: "evm",
};

function order(overrides: Record<string, unknown> = {}) {
  return {
    userId: 1,
    walletId: 7,
    tokenIn: "STX",
    tokenOut: "USDCx",
    direction: "BUY",
    targetPrice: 1,
    amountIn: 10,
    ...overrides,
  };
}

describe("limit order chain scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findWalletById.mockResolvedValue(BASE_WALLET);
    getSwappableTokens.mockResolvedValue([]);
    limitOrderCreate.mockImplementation(async ({ data }: { data: unknown }) => data);
  });

  it("asks for a route on the wallet's own chain", async () => {
    getBestQuote.mockResolvedValue({ quote: { amountOut: 9 } });

    await LimitOrderService.getInstance().create(order());

    expect(getBestQuote).toHaveBeenCalledWith("STX", "USDCx", 10, "base:mainnet");
  });

  it("refuses an order whose pair cannot route on that chain", async () => {
    // The Stacks router is not consulted for a Base wallet, so nothing answers.
    getBestQuote.mockResolvedValue(null);

    await expect(LimitOrderService.getInstance().create(order())).rejects.toThrow(
      /No DEX route found/
    );
    expect(limitOrderCreate).not.toHaveBeenCalled();
  });

  it("names the chain when it refuses", async () => {
    // "No route" on its own reads as a liquidity problem. It is usually a
    // wrong-network problem, and the message has to say which network.
    getBestQuote.mockResolvedValue(null);

    await expect(LimitOrderService.getInstance().create(order())).rejects.toThrow(
      /base:mainnet/
    );
  });

  it("scopes the balance check to the wallet's chain too", async () => {
    getBestQuote.mockResolvedValue({ quote: { amountOut: 9 } });

    await LimitOrderService.getInstance().create(order());

    expect(getSwappableTokens).toHaveBeenCalledWith(false, "base:mainnet");
  });
});
