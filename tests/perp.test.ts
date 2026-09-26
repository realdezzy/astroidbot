import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { PerpService } from "../src/services/perp/perpService.js";
import { ConfigManager } from "../src/config.js";

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
    findTradeSettings: vi.fn().mockResolvedValue({
      useGasless: false,
      gaslessFeeToken: "USDC",
    }),
    prisma: mockPrisma,
  };

  return {
    DatabaseService: {
      getInstance: () => mockDbInstance,
    },
  };
});

vi.mock("../src/services/transaction.js", () => ({
  createSTXPostCondition: vi.fn().mockReturnValue({}),
}));

// Perps execute through the shared chain dispatch point now, not by calling
// TransactionService directly. Partial mock because walletChain.js imports
// resolveChainId from this module.
// vi.hoisted: PerpService is imported statically at the top of this file, so a
// plain const would not be initialised by the time the mock factory runs.
const { executeSwapPayload } = vi.hoisted(() => ({
  executeSwapPayload: vi.fn().mockResolvedValue({ txId: "0x123456" }),
}));
vi.mock("../src/services/chains/executeSwap.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  executeSwapPayload,
}));

vi.mock("../src/services/riskManager.js", () => ({
  RiskManager: { getInstance: () => ({ evaluateTrade: vi.fn().mockResolvedValue({ approved: true }) }) },
}));

vi.mock("../src/services/tradeSettings.js", () => ({
  resolveTradeSettings: vi.fn().mockResolvedValue({
    slippageBps: 100, maxPositionPct: 25, dailyLossLimit: 5, useGasless: false,
  }),
}));

vi.mock("../src/services/portfolio.js", () => ({
  PortfolioManager: {
    getInstance: () => ({
      fetchBalances: vi.fn().mockResolvedValue([
        { token: "STX", symbol: "STX", balance: 10_000, usdValue: 25_000 },
      ]),
    }),
  },
}));

vi.mock("../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: { getInstance: () => ({ getSwappableTokens: vi.fn().mockResolvedValue([]) }) },
}));

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

    // The contract call is now carried as a TransactionPayload through the one
    // dispatch point every other trade path uses, rather than handed to
    // TransactionService directly.
    expect(executeSwapPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "stacks",
        contractAddress: config.VELAR_PERP_CONTRACT_ADDRESS,
        contractName: config.VELAR_PERP_CONTRACT_NAME,
        functionName: "open-position",
        functionArgs: expect.arrayContaining(["'STX", "'LONG", "u5", "u100000000"]),
        postConditions: expect.any(Array),
      }),
      expect.objectContaining({
        walletId: 1,
        senderAddress: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
        maxOutbound: 200,
        chainId: "stacks:mainnet",
      })
    );
  });
});
