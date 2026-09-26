import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";

/**
 * Perps predate three rules the rest of the trading paths follow, and the gap
 * mattered most on the one path that decides whether someone is liquidated.
 *
 * `openPosition` and `closePosition` each began with `let entryPrice = 2.0` /
 * `let currentPrice = 2.0`, filled in from Velar on the happy path and left at
 * $2.00 when the lookup threw. The close path feeds that straight into
 *
 *     isLiquidated = direction === "LONG"
 *       ? currentPrice <= position.liquidationPrice
 *       : currentPrice >= position.liquidationPrice
 *
 * so a failed price call did not merely mis-report PnL — it liquidated, or
 * declined to liquidate, a leveraged position against a number nobody
 * observed. The repo had already made this decision twice elsewhere ("stop
 * fabricating market data", "an unpriceable token is not a token worth zero");
 * perps never got the same treatment.
 *
 * The other two: no `RiskManager` anywhere in the module, so `maxPositionPct`
 * and `dailyLossLimit` did not apply to leverage — the highest-risk product on
 * the platform was the only one with no exposure ceiling. And
 * `db.findTradeSettings` directly, which CLAUDE.md forbids on a path that
 * knows its chain.
 */

const getTokensMeta = vi.fn();
vi.mock("@velarprotocol/velar-sdk", () => ({ getTokensMeta }));

const perpCreate = vi.fn();
const perpFindUnique = vi.fn();
const perpUpdate = vi.fn();
const findWalletById = vi.fn();

vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({
      findWalletById,
      prisma: {
        perpPosition: { create: perpCreate, findUnique: perpFindUnique, update: perpUpdate },
      },
    }),
  },
}));

const executeSwapPayload = vi.fn();
// Partial: `walletChain.js` imports `resolveChainId` from this module, so a
// wholesale replacement breaks the chain lookup rather than the dispatch call.
vi.mock("../../../src/services/chains/executeSwap.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  executeSwapPayload,
}));

vi.mock("../../../src/services/transaction.js", () => ({
  createSTXPostCondition: vi.fn().mockReturnValue({}),
}));

const evaluateTrade = vi.fn();
vi.mock("../../../src/services/riskManager.js", () => ({
  RiskManager: { getInstance: () => ({ evaluateTrade }) },
}));

const resolveTradeSettings = vi.fn();
vi.mock("../../../src/services/tradeSettings.js", () => ({ resolveTradeSettings }));

vi.mock("../../../src/services/portfolio.js", () => ({
  PortfolioManager: {
    getInstance: () => ({
      fetchBalances: vi.fn().mockResolvedValue([
        { token: "STX", symbol: "STX", balance: 10_000, usdValue: 25_000 },
      ]),
    }),
  },
}));

vi.mock("../../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: {
    getInstance: () => ({ getSwappableTokens: vi.fn().mockResolvedValue([]) }),
  },
}));

const WALLET = {
  id: 1,
  userId: 10,
  address: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
  chain: "stacks:mainnet",
  chainFamily: "stacks",
};

const { PerpService } = await import("../../../src/services/perp/perpService.js");
const { ConfigManager } = await import("../../../src/config.js");

describe("perp safety", () => {
  beforeAll(() => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.reset();
    ConfigManager.load();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    findWalletById.mockResolvedValue(WALLET);
    getTokensMeta.mockResolvedValue([{ symbol: "STX", price: "2.5" }]);
    executeSwapPayload.mockResolvedValue({ txId: "0xabc" });
    perpCreate.mockImplementation(async ({ data }) => ({ id: 42, ...data }));
    resolveTradeSettings.mockResolvedValue({
      slippageBps: 100, maxPositionPct: 25, dailyLossLimit: 5, useGasless: false,
    });
    evaluateTrade.mockResolvedValue({ approved: true });
  });

  describe("unknown prices", () => {
    it("refuses to open a position when the price lookup throws", async () => {
      getTokensMeta.mockRejectedValue(new Error("velar down"));

      await expect(
        PerpService.getInstance().openPosition(10, 1, "STX-PERP", "LONG", 100, 5)
      ).rejects.toThrow(/price/i);

      expect(executeSwapPayload).not.toHaveBeenCalled();
      expect(perpCreate).not.toHaveBeenCalled();
    });

    it("refuses to open when the market is absent from the price feed", async () => {
      // A cheerful empty list is the same problem as a thrown error: no price.
      getTokensMeta.mockResolvedValue([]);

      await expect(
        PerpService.getInstance().openPosition(10, 1, "STX-PERP", "LONG", 100, 5)
      ).rejects.toThrow(/price/i);
      expect(perpCreate).not.toHaveBeenCalled();
    });

    it("refuses to close a position when the price lookup throws", async () => {
      // The important one. A close with an unknown price used to decide
      // liquidation against $2.00.
      perpFindUnique.mockResolvedValue({
        id: 42, userId: 10, walletId: 1, market: "STX-PERP", direction: "LONG",
        status: "OPEN", size: 500, margin: 100, entryPrice: 2.5, liquidationPrice: 2.05,
      });
      getTokensMeta.mockRejectedValue(new Error("velar down"));

      await expect(PerpService.getInstance().closePosition(10, 42)).rejects.toThrow(/price/i);

      expect(executeSwapPayload).not.toHaveBeenCalled();
      expect(perpUpdate).not.toHaveBeenCalled();
    });

    it("never invents a $2.00 price", async () => {
      // Pins the specific constant, because it read as a plausible STX price
      // and that is exactly why it survived review.
      getTokensMeta.mockResolvedValue([{ symbol: "STX", price: "2.5" }]);

      const position = await PerpService.getInstance().openPosition(10, 1, "STX-PERP", "LONG", 100, 5);

      expect(position.entryPrice).toBe(2.5);
      expect(position.entryPrice).not.toBe(2.0);
    });
  });

  describe("risk limits", () => {
    it("evaluates leverage against the user's risk limits", async () => {
      await PerpService.getInstance().openPosition(10, 1, "STX-PERP", "LONG", 100, 5);
      expect(evaluateTrade).toHaveBeenCalledTimes(1);
    });

    it("sizes the check on the leveraged notional, not the margin", async () => {
      // 100 of margin at 5x is 500 of exposure. Checking the margin would let a
      // user take five times the position their cap allows.
      await PerpService.getInstance().openPosition(10, 1, "STX-PERP", "LONG", 100, 5);

      expect(evaluateTrade).toHaveBeenCalledWith(
        10,
        expect.objectContaining({ amountIn: 500 }),
        expect.any(Array),
        { slippageBps: 100, maxPositionPct: 25, dailyLossLimit: 5 }
      );
    });

    it("does not open a position when risk declines it", async () => {
      evaluateTrade.mockResolvedValue({ approved: false, reason: "Position too large" });

      await expect(
        PerpService.getInstance().openPosition(10, 1, "STX-PERP", "LONG", 100, 5)
      ).rejects.toThrow(/Position too large/);

      expect(executeSwapPayload).not.toHaveBeenCalled();
      expect(perpCreate).not.toHaveBeenCalled();
    });

    it("lets a position be closed even when risk would decline opening one", async () => {
      // Closing reduces exposure. Gating it on the same limit that stopped the
      // open would trap users in positions precisely when they are over their
      // cap, which is when they most need out.
      evaluateTrade.mockResolvedValue({ approved: false, reason: "Daily loss limit reached" });
      perpFindUnique.mockResolvedValue({
        id: 42, userId: 10, walletId: 1, market: "STX-PERP", direction: "LONG",
        status: "OPEN", size: 500, margin: 100, entryPrice: 2.5, liquidationPrice: 2.05,
      });
      perpUpdate.mockImplementation(async ({ data }) => ({ id: 42, ...data }));

      await expect(PerpService.getInstance().closePosition(10, 42)).resolves.toBeDefined();
      expect(executeSwapPayload).toHaveBeenCalled();
    });
  });

  describe("chain dispatch", () => {
    it("executes through the chain dispatch point, not TransactionService", async () => {
      await PerpService.getInstance().openPosition(10, 1, "STX-PERP", "LONG", 100, 5);

      expect(executeSwapPayload).toHaveBeenCalledTimes(1);
      const [payload, params] = executeSwapPayload.mock.calls[0]!;
      expect(payload.functionName).toBe("open-position");
      expect(params.chainId).toBe("stacks:mainnet");
    });

    it("keeps the STX post-condition on the payload", async () => {
      // The post-condition is what caps how much STX can leave the wallet.
      // Routing through a new path must not drop it.
      await PerpService.getInstance().openPosition(10, 1, "STX-PERP", "LONG", 100, 5);

      const [payload] = executeSwapPayload.mock.calls[0]!;
      expect(payload.postConditions).toHaveLength(1);
    });

    it("reads settings through the chain-aware resolver", async () => {
      await PerpService.getInstance().openPosition(10, 1, "STX-PERP", "LONG", 100, 5);
      expect(resolveTradeSettings).toHaveBeenCalledWith(10, "personal", "stacks:mainnet");
    });
  });
});
