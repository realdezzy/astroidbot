import { describe, it, expect, beforeAll, vi } from "vitest";
import { TransactionService } from "../../src/services/transaction.js";
import { ConfigManager } from "../../src/config.js";
import { DatabaseService } from "../../src/services/db.js";
import { RedisService } from "../../src/services/redis.js";
import { KMSService } from "../../src/services/kms.js";
import { Cl } from "@stacks/transactions";

// Mock Database, Redis, and KMS to run without needing real databases configured
vi.mock("../../src/services/db.js", () => {
  const mockDbInstance = {
    hasPendingTradesForWallet: vi.fn().mockResolvedValue(false),
    findWalletById: vi.fn().mockResolvedValue({
      id: 1,
      address: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
      encryptedKey: "mock-encrypted-key",
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
    decryptPrivateKey: vi.fn().mockResolvedValue("75717b832dd74002b83d1c16828b248a709020928a54aa47be8fbd8f167531d901"),
  };
  return {
    KMSService: {
      getInstance: () => mockKmsInstance,
    },
  };
});

describe("TransactionService Devnet Integration Test", () => {
  beforeAll(() => {
    // Set up Devnet configuration envs
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.TELEGRAM_WEBHOOK_URL = "https://example.com/webhook";
    process.env.STACKS_NETWORK = "mocknet";
    process.env.STACKS_API_URL = "http://localhost:3999";
    process.env.DRY_RUN = "false"; // We want to broadcast to the local node

    // Reset ConfigManager instance for network settings reload
    (ConfigManager as any).instance = undefined;
    ConfigManager.load();
  });

  it("should connect, estimate fees, sign, broadcast, and confirm a transaction to local devnet", async () => {
    const txService = TransactionService.getInstance();
    
    // We will test using a contract call to the Stacks system pox-4 contract on devnet.
    // Even if it aborts on-chain, it should successfully broadcast and return a transaction ID.
    const action = {
      tokenIn: "STX",
      tokenOut: "STX",
      amountIn: 0.1,
      direction: "BUY" as const,
      reason: "Devnet Integration Test",
    };

    const recipientPrincipal = Cl.principal("ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM");

    // pox-4 is SP000000000000000000002286XDF.pox-4 on mainnet.
    // On devnet, it is ST000000000000000000002286XDF.pox-4.
    const contractAddress = "ST000000000000000000002286XDF";
    const contractName = "pox-4";
    const functionName = "allow-contract-caller";
    const functionArgs = [recipientPrincipal, Cl.none()];

    console.log("Checking if local Devnet node is running at http://localhost:3999...");
    try {
      const response = await fetch("http://localhost:3999/v2/info");
      if (!response.ok) {
        throw new Error("Devnet node returned non-OK status");
      }
      console.log("Local Devnet is online! Proceeding with transaction broadcast...");
    } catch (err) {
      console.warn("Devnet node is NOT running locally. Skipping live broadcast validation.");
      // Skip the test gracefully since devnet isn't running in CI/offline test environment
      return;
    }

    const result = await txService.execute(
      action,
      contractAddress,
      contractName,
      functionName,
      functionArgs,
      1, // walletId
      "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM", // senderAddress
      100 // maxOutbound
    );

    expect(result).toBeDefined();
    if ("error" in result) {
      console.error("Broadcast failed:", result.error);
      // Fail test if we get an unexpected execution error while devnet is running
      expect.fail(result.error);
    } else {
      expect(result.txId).toBeDefined();
      expect(result.txId).toMatch(/^0x[a-fA-F0-9]{64}$/);
      console.log(`Transaction successfully broadcasted to local Devnet! TxID: ${result.txId}`);

      console.log("Waiting for confirmation on local Devnet...");
      const confirmed = await txService.confirmTransaction(result.txId, 9999);
      expect(confirmed).toBe(true);
    }
  }, 600000); // 10 minutes timeout
});
