import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createServer } from "../../../src/api/server.js";
import { ConfigManager } from "../../../src/config.js";
import type { Server } from "node:http";

const mockDbInstance = {
  healthCheck: vi.fn().mockResolvedValue(true),
  findWalletById: vi.fn(),
  findDefaultWalletByUserId: vi.fn(),
  findTradeSettings: vi.fn(),
  getDailyTradesSince: vi.fn().mockResolvedValue([]),
  createTrade: vi.fn(),
  updateTradeStatus: vi.fn(),
  prisma: {
    limitOrder: { findMany: vi.fn().mockResolvedValue([]) },
    trade: { findMany: vi.fn().mockResolvedValue([]) },
  },
};

const mockRegistryInstance = {
  getSwappableTokens: vi.fn().mockResolvedValue([]),
  getBestQuote: vi.fn(),
  getProvider: vi.fn(),
};

const mockPmInstance = {
  fetchBalances: vi.fn(),
};

const mockTxServiceInstance = {
  execute: vi.fn(),
};

vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => mockDbInstance },
}));

vi.mock("../../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: { getInstance: () => mockRegistryInstance },
}));

vi.mock("../../../src/services/portfolio.js", () => ({
  PortfolioManager: { getInstance: () => mockPmInstance },
}));

vi.mock("../../../src/services/transaction.js", () => ({
  TransactionService: { getInstance: () => mockTxServiceInstance },
}));

vi.mock("../../../src/services/redis.js", () => ({
  RedisService: { getInstance: () => ({ get: vi.fn(), set: vi.fn() }) },
}));

vi.mock("../../../src/services/queue.js", () => ({
  QueueManager: {
    getInstance: () => ({
      getQueue: () => ({ client: Promise.resolve({ ping: () => Promise.resolve("PONG") }) }),
    }),
  },
  QUEUES: { TRADE_EXECUTION: "TRADE_EXECUTION" },
}));

vi.mock("../../../src/services/telegram.js", () => ({
  TelegramService: { getInstance: () => ({ getWebhookPath: () => null }) },
}));

vi.mock("../../../src/api/websocket.js", () => ({
  WebSocketManager: { getInstance: () => ({ initialize: vi.fn(), getConnectedCount: () => 0 }) },
}));

describe("POST /api/me/trades/execute — RiskManager gating", () => {
  let server: Server;
  let token: string;

  beforeAll(() => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.PORT = "8011";
    process.env.DRY_RUN = "true";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.load();
    server = createServer();
    token = jwt.sign({ userId: 10 }, ConfigManager.getInstance().config.JWT_SECRET);
  });

  afterAll(() => {
    server?.close?.();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbInstance.getDailyTradesSince.mockResolvedValue([]);
    mockDbInstance.prisma.limitOrder.findMany.mockResolvedValue([]);
    mockDbInstance.prisma.trade.findMany.mockResolvedValue([]);
    mockDbInstance.findWalletById.mockResolvedValue({ id: 1, userId: 10, address: "SP123" });
    mockDbInstance.findTradeSettings.mockResolvedValue(null); // exercises default risk settings
    mockRegistryInstance.getSwappableTokens.mockResolvedValue([]);
  });

  it("rejects a manual trade that would exceed the (default) max position percentage, without touching the DEX/TransactionService", async () => {
    mockPmInstance.fetchBalances.mockResolvedValue([
      { token: "STX", symbol: "STX", balance: 100, usdValue: 100 },
    ]);

    const res = await request(server)
      .post("/api/me/trades/execute")
      .set("Authorization", `Bearer ${token}`)
      .send({
        walletId: 1,
        tokenIn: "STX",
        tokenOut: "USDCx",
        amountIn: 50, // 50% of a $100 portfolio — exceeds the default 25% cap
        direction: "BUY",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/max position/i);
    expect(mockRegistryInstance.getBestQuote).not.toHaveBeenCalled();
    expect(mockTxServiceInstance.execute).not.toHaveBeenCalled();
  });

  it("allows a manual trade within the max position percentage to proceed to execution", async () => {
    mockPmInstance.fetchBalances.mockResolvedValue([
      { token: "STX", symbol: "STX", balance: 100, usdValue: 100 },
    ]);
    mockRegistryInstance.getBestQuote.mockResolvedValue({
      providerName: "ALEX",
      quote: { amountOut: 9.9, priceImpact: 0.1, feeBps: 30, feeAmount: 0.03 },
    });
    mockRegistryInstance.getProvider.mockReturnValue({
      name: "ALEX",
      buildSwapPayload: vi.fn().mockResolvedValue({
        contractAddress: "SP1",
        contractName: "pool",
        functionName: "swap",
        functionArgs: [],
        postConditions: [],
      }),
    });
    mockTxServiceInstance.execute.mockResolvedValue({ txId: "0xabc" });
    mockDbInstance.createTrade.mockResolvedValue({ id: 55 });

    const res = await request(server)
      .post("/api/me/trades/execute")
      .set("Authorization", `Bearer ${token}`)
      .send({
        walletId: 1,
        tokenIn: "STX",
        tokenOut: "USDCx",
        amountIn: 10, // 10% of a $100 portfolio — within the default 25% cap
        direction: "BUY",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ ok: true, tradeId: 55, txId: "0xabc" }));
    expect(mockTxServiceInstance.execute).toHaveBeenCalled();
  });
});
