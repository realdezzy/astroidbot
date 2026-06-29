import { describe, it, expect, beforeAll, vi, beforeEach } from "vitest";
import { TransactionService } from "../src/services/transaction.js";
import { ConfigManager } from "../src/config.js";
import * as stacksTx from "@stacks/transactions";

// Mock @stacks/transactions
vi.mock("@stacks/transactions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stacks/transactions")>();
  return {
    ...actual,
    makeContractCall: vi.fn().mockResolvedValue({
      serialize: vi.fn().mockReturnValue(Buffer.from("dummy-tx-payload")),
    }),
    broadcastTransaction: vi.fn().mockResolvedValue({ txid: "fallback-standard-tx-id" }),
  };
});

const mockSponsor = vi.fn();

// Mock @velumx/sdk
vi.mock("@velumx/sdk", () => {
  return {
    VelumXClient: vi.fn().mockImplementation(() => {
      return {
        sponsor: mockSponsor,
      };
    }),
  };
});

// Mock Database, Redis, and KMS
vi.mock("../src/services/db.js", () => {
  const mockDbInstance = {
    hasPendingTradesForWallet: vi.fn().mockResolvedValue(false),
    findWalletById: vi.fn().mockResolvedValue({
      id: 2,
      address: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
      encryptedKey: "mock-encrypted-key",
    }),
  };
  return {
    DatabaseService: {
      getInstance: () => mockDbInstance,
    },
  };
});

vi.mock("../src/services/redis.js", () => {
  const mockRedisInstance = {
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(true),
  };
  return {
    RedisService: {
      getInstance: () => mockRedisInstance,
    },
  };
});

vi.mock("../src/services/kms.js", () => {
  const mockKmsInstance = {
    decryptPrivateKey: vi.fn().mockResolvedValue("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01"),
  };
  return {
    KMSService: {
      getInstance: () => mockKmsInstance,
    },
  };
});

describe("VelumX Gasless Integration Tests", () => {
  let txService: TransactionService;

  beforeAll(() => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.TELEGRAM_WEBHOOK_URL = "https://example.com/webhook";
    process.env.VELUMX_RELAYER_URL = "https://api.velumx.xyz/api/v1";
    process.env.VELUMX_API_KEY = "mocked-api-key";
    process.env.STACKS_NETWORK = "testnet";
    process.env.DRY_RUN = "false";
    ConfigManager.load();
    txService = TransactionService.getInstance();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Globally mock private network methods to prevent timeouts
    vi.spyOn(txService as any, "fetchOnChainNonce").mockResolvedValue(0);
    vi.spyOn(txService as any, "fetchFeeRate").mockResolvedValue(1.5);
    vi.spyOn(txService as any, "verifyMempoolAdmission").mockResolvedValue(true);
  });

  it("should construct and route a sponsored transaction through VelumX client when useGasless is true", async () => {
    mockSponsor.mockResolvedValue({ txid: "mocked-velumx-tx-id" });

    const makeContractCallSpy = vi.spyOn(stacksTx, "makeContractCall");

    const action = {
      tokenIn: "STX",
      tokenOut: "USDC",
      amountIn: 10,
      direction: "BUY" as const,
      reason: "Unit test gasless swap",
    };

    const result = await txService.execute(
      action,
      "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1",
      "usdc-token",
      "swap",
      [],
      2,
      "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
      100,
      true // useGasless = true
    );

    expect(mockSponsor).toHaveBeenCalled();
    expect(makeContractCallSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sponsored: true,
        fee: 0n,
      })
    );
    expect(result).toEqual({ txId: "mocked-velumx-tx-id" });
  });

  it("should gracefully fall back to standard transaction signing if the VelumX relayer fails", async () => {
    mockSponsor.mockRejectedValue(new Error("VelumX relayer offline"));

    const broadcastSpy = vi.spyOn(stacksTx, "broadcastTransaction")
      .mockResolvedValue({ txid: "fallback-standard-tx-id" });

    const action = {
      tokenIn: "STX",
      tokenOut: "USDC",
      amountIn: 10,
      direction: "BUY" as const,
      reason: "Unit test fallback swap",
    };

    const result = await txService.execute(
      action,
      "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1",
      "usdc-token",
      "swap",
      [],
      2,
      "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
      100,
      true // useGasless = true
    );

    expect(mockSponsor).toHaveBeenCalled();
    expect(broadcastSpy).toHaveBeenCalled();
    expect(result).toEqual({ txId: "fallback-standard-tx-id" });
  });
});
