import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";

/**
 * `processTradeJob` is the registered handler for the `trade-execution` queue,
 * which is how every surface except the inline web path executes a trade:
 * Telegram confirms, the autonomous cycle, social trading and the Mini App.
 *
 * It had no tests, and the gap hid a total outage. The worker synthesised the
 * portfolio it handed `RiskManager` as a single entry holding exactly the
 * amount being traded, so the position it was checking was always 100% of the
 * portfolio by construction: every buy exceeded `maxPositionPct` (25) and
 * every sell exceeded the 50% sell ceiling. `RiskManager`'s own unit tests
 * stayed green because the unit was correct — only its caller was not.
 *
 * The first test below is that outage. It fails against a worker that invents
 * its balances and passes against one that reads them.
 */

const mockGetDailyTradesSince = vi.fn();
const mockFindWalletById = vi.fn();
const mockCreateTrade = vi.fn();
const mockFindTradeByIdempotencyKey = vi.fn();
const mockUpdateTradeStatus = vi.fn();
const mockFetchBalances = vi.fn();
const mockGetBestQuote = vi.fn();
const mockGetSwappableTokens = vi.fn();
const mockBuildSwapPayload = vi.fn();
const mockExecuteSwapPayload = vi.fn();
const mockEnqueueConfirmation = vi.fn();
const mockResolveTradeSettings = vi.fn();

vi.mock("../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({
      getDailyTradesSince: mockGetDailyTradesSince,
      findWalletById: mockFindWalletById,
      createTrade: mockCreateTrade,
      findTradeByIdempotencyKey: mockFindTradeByIdempotencyKey,
      updateTradeStatus: mockUpdateTradeStatus,
    }),
  },
}));

vi.mock("../../src/services/portfolio.js", () => ({
  PortfolioManager: { getInstance: () => ({ fetchBalances: mockFetchBalances }) },
}));

vi.mock("../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: {
    getInstance: () => ({
      getBestQuote: mockGetBestQuote,
      getSwappableTokens: mockGetSwappableTokens,
      getProvider: () => ({ buildSwapPayload: mockBuildSwapPayload }),
    }),
  },
}));

vi.mock("../../src/services/queue.js", () => ({
  QueueManager: { getInstance: () => ({ enqueueConfirmation: mockEnqueueConfirmation }) },
}));

vi.mock("../../src/services/chains/executeSwap.js", () => ({
  executeSwapPayload: mockExecuteSwapPayload,
}));

vi.mock("../../src/services/tradeSettings.js", () => ({
  resolveTradeSettings: mockResolveTradeSettings,
}));

vi.mock("../../src/services/telegram.js", () => ({
  TelegramService: { getInstance: () => ({ isEnabled: () => false, sendAlert: vi.fn() }) },
}));

vi.mock("../../src/api/websocket.js", () => ({
  WebSocketManager: { getInstance: () => ({ broadcastTradeEvent: vi.fn() }) },
}));

vi.mock("../../src/services/chains/walletChain.js", () => ({
  walletChainId: () => "base:mainnet",
}));

const { processTradeJob } = await import("../../src/workers/tradeWorker.js");

/** A job in the shape the five `enqueueTrade` call sites produce. */
function job(overrides: Record<string, unknown> = {}): Job<never> {
  return {
    id: "job-1",
    data: {
      walletId: 7,
      userId: 1,
      senderAddress: "0xabc",
      tokenIn: "USDC",
      tokenOut: "WETH",
      amountIn: 100,
      direction: "BUY",
      reason: "test",
      ...overrides,
    },
  } as unknown as Job<never>;
}

describe("processTradeJob", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetDailyTradesSince.mockResolvedValue([]);
    mockFindWalletById.mockResolvedValue({ id: 7, userId: 1, address: "0xabc", chain: "base:mainnet", chainFamily: "evm" });
    mockResolveTradeSettings.mockResolvedValue({
      slippageBps: 100,
      maxPositionPct: 25.0,
      dailyLossLimit: 5.0,
      rebalanceThreshold: 2.0,
      useGasless: false,
      gaslessFeeToken: "USDC",
    });
    mockGetSwappableTokens.mockResolvedValue([]);
    // A $10,000 portfolio. A $100 buy is 1% of it — comfortably inside the
    // 25% cap, so nothing here should be rejected on position size.
    mockFetchBalances.mockResolvedValue([
      { token: "USDC", symbol: "USDC", balance: 9000, usdValue: 9000 },
      { token: "WETH", symbol: "WETH", balance: 0.4, usdValue: 1000 },
    ]);
    mockGetBestQuote.mockResolvedValue({
      providerName: "UniswapV3-base:mainnet",
      quote: { amountOut: 0.04, feeAmount: 0.3, feeBps: 30 },
    });
    mockBuildSwapPayload.mockResolvedValue({ kind: "evm", calls: [] });
    mockCreateTrade.mockResolvedValue({ id: 42 });
    mockFindTradeByIdempotencyKey.mockResolvedValue(null);
    mockExecuteSwapPayload.mockResolvedValue({ txId: "0xdeadbeef" });
  });

  it("executes a buy that is small relative to the real portfolio", async () => {
    await expect(processTradeJob(job())).resolves.toBeUndefined();

    expect(mockExecuteSwapPayload).toHaveBeenCalledOnce();
    expect(mockUpdateTradeStatus).toHaveBeenCalledWith(42, "BROADCAST", "0xdeadbeef");
  });

  it("executes a sell that is a small fraction of the held position", async () => {
    await expect(
      processTradeJob(job({ tokenIn: "WETH", tokenOut: "USDC", amountIn: 0.02, direction: "SELL" }))
    ).resolves.toBeUndefined();

    expect(mockExecuteSwapPayload).toHaveBeenCalledOnce();
  });

  it("evaluates risk against the wallet's real balances, not the trade amount", async () => {
    await processTradeJob(job());

    expect(mockFetchBalances).toHaveBeenCalled();
    const [address, , userId] = mockFetchBalances.mock.calls[0]!;
    expect(address).toBe("0xabc");
    expect(userId).toBe(1);
  });

  it("still rejects a buy that would genuinely breach the position cap", async () => {
    // $9,000 into a token already worth $1,000 of a $10,000 portfolio leaves
    // the whole portfolio in WETH — 100%, far over the 25% cap.
    await expect(processTradeJob(job({ amountIn: 9000 }))).rejects.toThrow(/Risk:/);
    expect(mockExecuteSwapPayload).not.toHaveBeenCalled();
  });

  it("rejects a sell larger than half the held position", async () => {
    await expect(
      processTradeJob(job({ tokenIn: "WETH", tokenOut: "USDC", amountIn: 0.3, direction: "SELL" }))
    ).rejects.toThrow(/Risk:/);
    expect(mockExecuteSwapPayload).not.toHaveBeenCalled();
  });

  describe("replay safety", () => {
    it("records the job id so a later attempt can recognise its own trade", async () => {
      await processTradeJob(job());

      expect(mockCreateTrade).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: "job-1" })
      );
    });

    it("refuses to broadcast again when a prior attempt already has a txId", async () => {
      // The job died after broadcasting and BullMQ replayed it. Executing here
      // would send a second swap and charge the user twice for one intent.
      mockFindTradeByIdempotencyKey.mockResolvedValue({ id: 42, txId: "0xalready", status: "BROADCAST" });

      await expect(processTradeJob(job())).resolves.toBeUndefined();

      expect(mockExecuteSwapPayload).not.toHaveBeenCalled();
      expect(mockCreateTrade).not.toHaveBeenCalled();
    });

    it("reuses the prior row and broadcasts when the previous attempt never did", async () => {
      // No txId means the previous attempt died before broadcasting, so the
      // retry is the whole point — but it must not orphan the existing row.
      mockFindTradeByIdempotencyKey.mockResolvedValue({ id: 42, txId: null, status: "PENDING" });

      await processTradeJob(job());

      expect(mockCreateTrade).not.toHaveBeenCalled();
      expect(mockExecuteSwapPayload).toHaveBeenCalledOnce();
      expect(mockUpdateTradeStatus).toHaveBeenCalledWith(42, "BROADCAST", "0xdeadbeef");
    });
  });
});
