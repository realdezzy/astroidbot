import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createServer } from "../../../src/api/server.js";
import { DatabaseService } from "../../../src/services/db.js";
import { ConfigManager } from "../../../src/config.js";
import type { Server } from "node:http";

const mockDbInstance = {
  healthCheck: vi.fn().mockResolvedValue(true),
  findUserByEmail: vi.fn(),
  createEmailUser: vi.fn(),
  markEmailVerified: vi.fn(),
  createRefreshToken: vi.fn(),
  findUserById: vi.fn(),
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    refreshToken: {
      updateMany: vi.fn(),
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

vi.mock("bcrypt", () => ({
  default: {
    hash: vi.fn().mockResolvedValue("$2b$12$mockedhashvalue"),
    compare: vi.fn(),
  },
}));

vi.mock("../../../src/services/wallet.js", () => ({
  provisionDefaultWallet: vi.fn().mockResolvedValue(undefined),
}));

describe("Auth Routes Integration Tests", () => {
  let server: Server;

  beforeAll(() => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.PORT = "8008";
    process.env.DRY_RUN = "true";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") {
      delete process.env.TELEGRAM_WEBHOOK_URL;
    }
    if (process.env.VELUMX_RELAYER_URL === "") {
      delete process.env.VELUMX_RELAYER_URL;
    }
    ConfigManager.load();
    server = createServer();
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /api/auth/email/register should register a user and return tokens", async () => {
    mockDbInstance.findUserByEmail.mockResolvedValue(null);
    mockDbInstance.createEmailUser.mockResolvedValue({
      id: 1,
      email: "test@example.com",
      username: "testuser",
      emailVerified: true,
      referralCode: "REF123",
      points: 0,
      telegramId: null,
      isActive: true,
    });

    const res = await request(server)
      .post("/api/auth/email/register")
      .send({
        email: "test@example.com",
        password: "password123",
        username: "testuser",
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("accessToken");
    expect(res.body).toHaveProperty("refreshToken");
    expect(res.body.user).toEqual({
      id: 1,
      email: "test@example.com",
      username: "testuser",
      emailVerified: true,
      referralCode: "REF123",
      points: 0,
      telegramId: null,
    });
  });

  it("POST /api/auth/email/login should reject invalid login credentials", async () => {
    mockDbInstance.findUserByEmail.mockResolvedValue(null); // User not found

    const res = await request(server)
      .post("/api/auth/email/login")
      .send({
        email: "nonexistent@example.com",
        password: "password123",
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Invalid email or password");
  });
});
