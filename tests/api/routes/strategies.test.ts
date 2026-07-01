import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createServer } from "../../../src/api/server.js";
import { DatabaseService } from "../../../src/services/db.js";
import { ConfigManager } from "../../../src/config.js";
import type { Server } from "node:http";

const mockDbInstance = {
  healthCheck: vi.fn().mockResolvedValue(true),
  prisma: {
    tradingStrategy: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    tradeAgent: {
      findUnique: vi.fn(),
    },
    wallet: {
      findMany: vi.fn(),
    },
  },
};

vi.mock("../../../src/services/db.js", () => {
  return {
    DatabaseService: {
      getInstance: () => mockDbInstance,
    },
  };
});

vi.mock("../../../src/services/redis.js", () => {
  return {
    RedisService: {
      getInstance: () => ({
        get: vi.fn(),
        set: vi.fn(),
      }),
    },
  };
});

vi.mock("../../../src/services/queue.js", () => {
  return {
    QueueManager: {
      getInstance: () => ({
        getQueue: () => ({
          client: Promise.resolve({ ping: () => Promise.resolve("PONG") }),
        }),
      }),
    },
    QUEUES: {
      TRADE_EXECUTION: "TRADE_EXECUTION",
    },
  };
});

vi.mock("../../../src/services/telegram.js", () => {
  return {
    TelegramService: {
      getInstance: () => ({
        getWebhookPath: () => null,
      }),
    },
  };
});

vi.mock("../../../src/api/websocket.js", () => {
  return {
    WebSocketManager: {
      getInstance: () => ({
        initialize: vi.fn(),
        getConnectedCount: () => 0,
      }),
    },
  };
});

describe("Strategies Routes Integration Tests", () => {
  let server: Server;
  let token: string;

  beforeAll(() => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.PORT = "8009";
    process.env.DRY_RUN = "true";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") {
      delete process.env.TELEGRAM_WEBHOOK_URL;
    }
    if (process.env.VELUMX_RELAYER_URL === "") {
      delete process.env.VELUMX_RELAYER_URL;
    }
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

  it("GET /api/me/strategies should require authentication", async () => {
    const res = await request(server).get("/api/me/strategies");
    expect(res.status).toBe(401);
  });

  it("GET /api/me/strategies should return user strategies when authenticated", async () => {
    const mockStrategies = [
      { id: 1, userId: 10, agentId: 2, type: "dca", config: {}, isActive: true },
    ];
    mockDbInstance.prisma.tradingStrategy.findMany.mockResolvedValue(mockStrategies);

    const res = await request(server)
      .get("/api/me/strategies")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.strategies).toEqual(mockStrategies);
  });

  it("POST /api/me/strategies should create a new strategy if inputs are valid", async () => {
    mockDbInstance.prisma.tradeAgent.findUnique.mockResolvedValue({ id: 2, userId: 10 });
    mockDbInstance.prisma.wallet.findMany.mockResolvedValue([{ id: 3, userId: 10 }]);
    mockDbInstance.prisma.tradingStrategy.create.mockResolvedValue({
      id: 1,
      userId: 10,
      agentId: 2,
      type: "dca",
      config: { walletIds: [3] },
      isActive: true,
    });

    const res = await request(server)
      .post("/api/me/strategies")
      .set("Authorization", `Bearer ${token}`)
      .send({
        agentId: 2,
        type: "dca",
        config: {},
        walletIds: [3],
        isActive: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(1);
    expect(mockDbInstance.prisma.tradingStrategy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 10,
        agentId: 2,
        type: "dca",
        isActive: true,
        config: expect.objectContaining({ walletIds: [3] }),
      }),
    });
  });

  it("POST /api/me/strategies should validate request body parameters", async () => {
    const res = await request(server)
      .post("/api/me/strategies")
      .set("Authorization", `Bearer ${token}`)
      .send({
        agentId: 2,
        type: "invalid-type-xyz", // not in STRATEGY_TYPES
        config: {},
        walletIds: [], // must have min 1
      });

    expect(res.status).toBe(422);
  });
});
