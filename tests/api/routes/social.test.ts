import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createServer } from "../../../src/api/server.js";
import { ConfigManager } from "../../../src/config.js";
import type { Server } from "node:http";

const mockSocialAccountDb = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

const mockSocialCommandDb = {
  findUnique: vi.fn(),
  update: vi.fn(),
};

const mockDbInstance = {
  healthCheck: vi.fn().mockResolvedValue(true),
  findWalletsByUserId: vi.fn(),
  findDefaultWalletByUserId: vi.fn(),
  prisma: {
    socialAccount: mockSocialAccountDb,
    socialCommand: mockSocialCommandDb,
  },
};

const mockEnqueueTrade = vi.fn().mockResolvedValue({ id: "job_123" });

vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => mockDbInstance,
  },
}));

vi.mock("../../../src/services/queue.js", () => ({
  QueueManager: {
    getInstance: () => ({
      enqueueTrade: mockEnqueueTrade,
      getQueue: () => ({
        client: Promise.resolve({ ping: () => Promise.resolve("PONG") }),
      }),
    }),
  },
  QUEUES: {
    TRADE_EXECUTION: "TRADE_EXECUTION",
  },
}));

vi.mock("../../../src/services/redis.js", () => ({
  RedisService: {
    getInstance: () => ({
      get: vi.fn(),
      set: vi.fn(),
    }),
  },
}));

vi.mock("../../../src/services/telegram.js", () => ({
  TelegramService: {
    getInstance: () => ({
      getWebhookPath: () => null,
    }),
  },
}));

vi.mock("../../../src/api/websocket.js", () => ({
  WebSocketManager: {
    getInstance: () => ({
      initialize: vi.fn(),
      getConnectedCount: () => 0,
    }),
  },
}));

describe("Social API Routes Integration Tests", () => {
  let server: Server;
  let token: string;

  beforeAll(() => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.PORT = "8015";
    process.env.DRY_RUN = "true";
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBHOOK_URL;
    delete process.env.VELUMX_RELAYER_URL;

    ConfigManager.load();
    server = createServer();
    token = jwt.sign({ userId: 10 }, ConfigManager.getInstance().config.JWT_SECRET);
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("GET /api/me/social-accounts returns linked social accounts for user", async () => {
    const mockAccounts = [
      { id: 1, userId: 10, platform: "x", handle: "trader", platformUserId: "123" },
    ];
    mockSocialAccountDb.findMany.mockResolvedValue(mockAccounts);

    const res = await request(server)
      .get("/api/me/social-accounts")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockAccounts);
    expect(mockSocialAccountDb.findMany).toHaveBeenCalledWith({
      where: { userId: 10 },
      orderBy: { createdAt: "asc" },
    });
  });

  it("POST /api/me/social-accounts links a new social account", async () => {
    mockSocialAccountDb.findUnique.mockResolvedValue(null);
    const createdAccount = {
      id: 2,
      userId: 10,
      platform: "farcaster",
      handle: "farcaster_user",
      platformUserId: "999",
      perTradeLimitUsd: 100,
      dailyLimitUsd: 500,
      autoExecute: false,
    };
    mockSocialAccountDb.create.mockResolvedValue(createdAccount);

    const res = await request(server)
      .post("/api/me/social-accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        platform: "farcaster",
        handle: "farcaster_user",
        platformUserId: "999",
        perTradeLimitUsd: 100,
        dailyLimitUsd: 500,
        autoExecute: false,
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(createdAccount);
  });

  it("PUT /api/me/social-accounts/:id updates an account", async () => {
    mockSocialAccountDb.findUnique.mockResolvedValue({ id: 1, userId: 10 });
    mockSocialAccountDb.update.mockResolvedValue({ id: 1, userId: 10, autoExecute: true });

    const res = await request(server)
      .put("/api/me/social-accounts/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ autoExecute: true });

    expect(res.status).toBe(200);
    expect(res.body.autoExecute).toBe(true);
  });

  it("DELETE /api/me/social-accounts/:id unlinks an account", async () => {
    mockSocialAccountDb.findUnique.mockResolvedValue({ id: 1, userId: 10 });
    mockSocialAccountDb.delete.mockResolvedValue({ id: 1 });

    const res = await request(server)
      .delete("/api/me/social-accounts/1")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("GET /api/me/social-commands/confirm returns pending command details", async () => {
    const futureDate = new Date(Date.now() + 300_000);
    mockSocialCommandDb.findUnique.mockResolvedValue({
      id: 5,
      platform: "x",
      postId: "p123",
      authorId: "123",
      rawText: "buy 25 usdc of degen",
      parsedIntent: JSON.stringify({ action: "buy", amount: 25, denomination: "usd", token: "DEGEN" }),
      status: "AWAITING_CONFIRMATION",
      confirmExpiresAt: futureDate,
    });

    const res = await request(server)
      .get("/api/me/social-commands/confirm?token=valid_token")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.command.parsedIntent).toEqual({ action: "buy", amount: 25, denomination: "usd", token: "DEGEN" });
  });

  it("POST /api/me/social-commands/confirm executes trade and updates command status", async () => {
    const futureDate = new Date(Date.now() + 300_000);
    mockSocialCommandDb.findUnique.mockResolvedValue({
      id: 5,
      platform: "x",
      parsedIntent: JSON.stringify({ action: "buy", amount: 25, denomination: "usd", token: "DEGEN" }),
      status: "AWAITING_CONFIRMATION",
      confirmExpiresAt: futureDate,
      socialAccount: { userId: 10 },
    });
    mockDbInstance.findWalletsByUserId.mockResolvedValue([
      { id: 1, address: "0x123", isDefault: true },
    ]);
    mockDbInstance.findDefaultWalletByUserId.mockResolvedValue({ id: 1, address: "0x123", isDefault: true });

    const res = await request(server)
      .post("/api/me/social-commands/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ token: "valid_token" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockEnqueueTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 1,
        userId: 10,
        tokenIn: "USDC",
        tokenOut: "DEGEN",
        amountIn: 25,
      })
    );
    expect(mockSocialCommandDb.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { status: "EXECUTED" },
    });
  });
});
