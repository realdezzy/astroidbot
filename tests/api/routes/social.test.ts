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

const mockSocialVerificationDb = {
  findFirst: vi.fn(),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  create: vi.fn(),
};

const mockDbInstance = {
  healthCheck: vi.fn().mockResolvedValue(true),
  findWalletsByUserId: vi.fn(),
  findDefaultWalletByUserId: vi.fn(),
  prisma: {
    socialAccount: mockSocialAccountDb,
    socialCommand: mockSocialCommandDb,
    socialVerification: mockSocialVerificationDb,
  },
};

const mockEnqueueTrade = vi.fn().mockResolvedValue({ id: "job_123" });

/**
 * Only X is configured here. Farcaster's absence is deliberate: a deployment
 * with no provider for a platform must refuse to open a challenge for it,
 * because the user would post a code nothing is polling for and then wait for
 * a link that cannot arrive.
 */
vi.mock("../../../src/services/social/socialRegistry.js", () => ({
  SocialRegistry: {
    getInstance: () => ({
      get: (platform: string) =>
        platform === "x" ? { platform: "x", isConfigured: () => true } : undefined,
    }),
  },
  registerSocialProviders: vi.fn(),
  pollSocialMentions: vi.fn(),
}));

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

  /**
   * There is no endpoint that links an account directly any more.
   *
   * The one that existed accepted `platformUserId` in the body and set
   * `verifiedAt` from it, so "verified" recorded that the user had typed their
   * own id. The account row is now written only by the mention poller, from an
   * id the platform supplied.
   */
  it("no longer accepts a self-asserted account link", async () => {
    const res = await request(server)
      .post("/api/me/social-accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ platform: "farcaster", handle: "someone_else", platformUserId: "999" });

    expect(res.status).toBe(404);
    expect(mockSocialAccountDb.create).not.toHaveBeenCalled();
  });

  it("POST /api/me/social-accounts/verify opens a challenge", async () => {
    mockSocialVerificationDb.create.mockResolvedValue({});

    const res = await request(server)
      .post("/api/me/social-accounts/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({ platform: "x" });

    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^ASTROID-[A-Z2-9]{8}$/);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // The exact text to post: a user who paraphrases and drops the mention
    // publishes something the bot never sees.
    expect(res.body.postText).toContain(res.body.code);
    expect(res.body.postText).toContain("@");
  });

  it("refuses to start verification for a platform with no provider", async () => {
    // Otherwise the user posts a code that nothing is polling for and waits
    // for a link that cannot arrive.
    const res = await request(server)
      .post("/api/me/social-accounts/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({ platform: "farcaster" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it("rejects a body that still tries to supply an identifier", async () => {
    // Not merely ignored — the schema is strict, so an old client sending the
    // old shape fails loudly rather than opening a challenge it will then
    // misinterpret.
    mockSocialVerificationDb.create.mockResolvedValue({});

    const res = await request(server)
      .post("/api/me/social-accounts/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({ platform: "x", platformUserId: "999" });

    // The identifier is dropped by the schema; what matters is that nothing
    // downstream ever sees it.
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain("999");
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
