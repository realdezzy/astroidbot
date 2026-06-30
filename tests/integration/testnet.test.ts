import { describe, it, expect, beforeAll, vi } from "vitest";
import { TransactionService } from "../../src/services/transaction.js";
import { ConfigManager } from "../../src/config.js";
import { DatabaseService } from "../../src/services/db.js";
import { RedisService } from "../../src/services/redis.js";
import { KMSService } from "../../src/services/kms.js";
import { Cl } from "@stacks/transactions";

// Retrieve testnet credentials from environment variables
const testnetPrivateKey = process.env.TESTNET_PRIVATE_KEY;
const testnetAddress = process.env.TESTNET_ADDRESS;

// Mock Database, Redis, and KMS
vi.mock("../../src/services/db.js", () => {
  const mockDbInstance = {
    hasPendingTradesForWallet: vi.fn().mockResolvedValue(false),
    findWalletById: vi.fn().mockResolvedValue({
      id: 2,
      address: process.env.TESTNET_ADDRESS || "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
      encryptedKey: "mock-encrypted-key-testnet",
    }),
    updateTransaction: vi.fn().mockResolvedValue({}),
    markTransactionFailed: vi.fn().mockResolvedValue({}),
    markTransactionAborted: vi.fn().mockResolvedValue({}),
    updateTradeStatus: vi.fn().mockResolvedValue({}),
    prisma: {
      limitOrder: {
        updateMany: vi.fn().mockResolvedValue({}),
      },
    },
  };
  return {
    DatabaseService: {
      getInstance: () => mockDbInstance,
    },
  };
});

vi.mock("../../src/services/redis.js", () => {
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

vi.mock("../../src/services/kms.js", () => {
  const mockKmsInstance = {
    decryptPrivateKey: vi.fn().mockResolvedValue(process.env.TESTNET_PRIVATE_KEY || ""),
  };
  return {
    KMSService: {
      getInstance: () => mockKmsInstance,
    },
  };
});

describe("TransactionService Testnet Integration Test", () => {
  beforeAll(() => {
    // Set up Testnet configuration envs
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.TELEGRAM_WEBHOOK_URL = "https://example.com/webhook";
    process.env.STACKS_NETWORK = "testnet";
    process.env.STACKS_API_URL = "https://api.testnet.hiro.so";
    process.env.DRY_RUN = "false"; // We want to broadcast to Testnet

    // Reset ConfigManager instance for network settings reload
    (ConfigManager as any).instance = undefined;
    ConfigManager.load();
  });

  it("should connect, estimate fees, sign, broadcast, and confirm a transaction to public Stacks Testnet", async () => {
    if (!testnetPrivateKey || !testnetAddress) {
      console.warn("TESTNET_PRIVATE_KEY or TESTNET_ADDRESS not set in env. Skipping Stacks Testnet integration test.");
      return;
    }

    const txService = TransactionService.getInstance();
    
    // We will call allow-contract-caller on the pox-4 contract on testnet.
    // Address of pox-4 on Testnet is ST000000000000000000002286XDF.pox-4
    const action = {
      tokenIn: "STX",
      tokenOut: "STX",
      amountIn: 0.1,
      direction: "BUY" as const,
      reason: "Testnet Integration Test",
    };

    const recipientPrincipal = Cl.principal(testnetAddress);
    const contractAddress = "ST000000000000000000002286XDF";
    const contractName = "pox-4";
    const functionName = "allow-contract-caller";
    const functionArgs = [recipientPrincipal, Cl.none()];

    console.log(`Broadcasting transaction to Stacks Testnet from address: ${testnetAddress}...`);
    const result = await txService.execute(
      action,
      contractAddress,
      contractName,
      functionName,
      functionArgs,
      2, // walletId
      testnetAddress,
      100 // maxOutbound
    );

    expect(result).toBeDefined();
    if ("error" in result) {
      console.error("Testnet Broadcast failed:", result.error);
      expect.fail(result.error);
    } else {
      expect(result.txId).toBeDefined();
      expect(result.txId).toMatch(/^0x[a-fA-F0-9]{64}$/);
      console.log(`Transaction successfully broadcasted to Stacks Testnet! TxID: ${result.txId}`);

      console.log("Waiting for confirmation on Stacks Testnet...");
      const state = await txService.confirmTransaction(result.txId, 9999, true);
      expect(state).toBe("confirmed");
    }
  }, 600000); // 10 minutes timeout
});
