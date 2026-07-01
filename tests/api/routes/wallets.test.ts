import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createServer } from "../../../src/api/server.js";
import { DatabaseService } from "../../../src/services/db.js";
import { DEXRegistry } from "../../../src/services/dex/dexRegistry.js";
import { PortfolioManager } from "../../../src/services/portfolio.js";
import { ConfigManager } from "../../../src/config.js";
import type { Server } from "node:http";

const mockDbInstance = {
  healthCheck: vi.fn().mockResolvedValue(true),
  findWalletsByUserId: vi.fn(),
  updateWalletBalance: vi.fn(),
  findWalletById: vi.fn(),
  prisma: {
    wallet: {
      delete: vi.fn(),
    },
  },
};

const mockRegistryInstance = {
  getSwappableTokens: vi.fn(),
  getTokenPrice: vi.fn(),
};

const mockPmInstance = {
  fetchBalances: vi.fn(),
};

vi.mock("../../../src/services/db.js", () => {
  return {
    DatabaseService: {
      getInstance: () => mockDbInstance,
    },
  };
});

vi.mock("../../../src/services/dex/dexRegistry.js", () => {
  return {
    DEXRegistry: {
      getInstance: () => mockRegistryInstance,
    },
  };
});

vi.mock("../../../src/services/portfolio.js", () => {
  return {
    PortfolioManager: {
      getInstance: () => mockPmInstance,
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

describe("Wallets Routes Integration Tests", () => {
  let server: Server;
  let token: string;

  beforeAll(() => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.PORT = "8010";
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

  it("GET /api/me/wallets should return list of user wallets with updated balances", async () => {
    const mockWallets = [
      { id: 1, address: "SP123", name: "Wallet 1", balance: 50, createdAt: new Date() },
    ];
    mockDbInstance.findWalletsByUserId.mockResolvedValue(mockWallets);
    mockRegistryInstance.getSwappableTokens.mockResolvedValue([]);
    mockRegistryInstance.getTokenPrice.mockResolvedValue(2.0);
    mockPmInstance.fetchBalances.mockResolvedValue([
      { symbol: "STX", balance: 100, usdValue: 200 },
    ]);

    const res = await request(server)
      .get("/api/me/wallets")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual(expect.objectContaining({
      id: 1,
      address: "SP123",
      balance: 100,
      balanceUsd: 200,
    }));
    expect(mockDbInstance.updateWalletBalance).toHaveBeenCalledWith(1, 100);
  });

  it("DELETE /api/me/wallets/:id should delete the wallet if owned by user", async () => {
    mockDbInstance.findWalletById.mockResolvedValue({ id: 1, userId: 10 });
    mockDbInstance.findWalletsByUserId.mockResolvedValue([
      { id: 1, userId: 10 },
      { id: 2, userId: 10 },
    ]);
    mockDbInstance.prisma.wallet.delete.mockResolvedValue({ id: 1 });

    const res = await request(server)
      .delete("/api/me/wallets/1")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockDbInstance.prisma.wallet.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it("DELETE /api/me/wallets/:id should fail if wallet is not found or not owned by user", async () => {
    mockDbInstance.findWalletById.mockResolvedValue(null);

    const res = await request(server)
      .delete("/api/me/wallets/999")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});
