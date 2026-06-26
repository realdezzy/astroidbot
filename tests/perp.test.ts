import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { PerpService } from "../src/services/perp/perpService.js";
import { ConfigManager } from "../src/config.js";
import { DatabaseService } from "../src/services/db.js";
import { TransactionService } from "../src/services/transaction.js";

vi.mock("@velarprotocol/velar-sdk", () => {
  return {
    getTokensMeta: vi.fn().mockImplementation(async () => {
      return [
        {
          id: "token-stx",
          symbol: "STX",
          name: "STX",
          contractAddress: "SP123",
          price: "2.5",
          tokenDecimalNum: "6",
          assetName: "STX",
          vsymbol: 1,
        },
      ];
    }),
  };
});

vi.mock("../src/services/db.js", () => {
  const mockPrisma = {
    perpPosition: {
      create: vi.fn().mockImplementation(async ({ data }) => {
        return {
          id: 42,
          createdAt: new Date(),
          updatedAt: new Date(),
          status: "OPEN",
          ...data,
        };
      }),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };

  const mockDbInstance = {
    findWalletById: vi.fn().mockImplementation(async (id: number) => {
      return {
        id,
        userId: 10,
        address: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
      };
    }),
    prisma: mockPrisma,
  };

  return {
    DatabaseService: {
      getInstance: () => mockDbInstance,
    },
  };
});

vi.mock("../src/services/transaction.js", () => {
  const mockTxInstance = {
    execute: vi.fn().mockResolvedValue({ txId: "0x123456" }),
  };
  return {
    TransactionService: {
      getInstance: () => mockTxInstance,
    },
  };
});

describe("PerpService", () => {
  beforeAll(() => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") {
      delete process.env.TELEGRAM_WEBHOOK_URL;
    }
    if (process.env.VELUMX_RELAYER_URL === "") {
      delete process.env.VELUMX_RELAYER_URL;
    }
    ConfigManager.load();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should open a position using ConfigManager configurations and Velar price details", async () => {
    const perpService = PerpService.getInstance();
    const config = ConfigManager.getInstance().config;

    expect(config.VELAR_PERP_CONTRACT_ADDRESS).toBeDefined();
    expect(config.VELAR_PERP_CONTRACT_NAME).toBeDefined();

    const position = await perpService.openPosition(
      10,
      1,
      "STX-PERP",
      "LONG",
      100,
      5
    );

    expect(position).toBeDefined();
    expect(position.entryPrice).toBe(2.5);
    expect(position.margin).toBe(100);
    expect(position.leverage).toBe(5);
    expect(position.size).toBe(500);
    expect(position.status).toBe("OPEN");
    expect(position.txId).toBe("0x123456");

    const txService = TransactionService.getInstance();
    expect(txService.execute).toHaveBeenCalledWith(
      expect.any(Object),
      config.VELAR_PERP_CONTRACT_ADDRESS,
      config.VELAR_PERP_CONTRACT_NAME,
      "open-position",
      expect.arrayContaining(["'STX", "'LONG", "u5", "u100000000"]),
      1,
      "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
      200,
      false,
      expect.any(Array)
    );
  });
});
