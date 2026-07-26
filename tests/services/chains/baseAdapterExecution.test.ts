import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { ConfigManager } from "../../../src/config.js";

// Separate file (not just a separate describe block) because ConfigManager
// is a process-wide singleton — DRY_RUN must be false *before* the first
// ConfigManager.load() call, which vitest's per-file module isolation gives us.
const FAKE_SAFE_ADDRESS = "0x2222222222222222222222222222222222222222";

const mockSmartAccountClient = {
  sendTransaction: vi.fn(),
};

const mockPublicClient = {
  getTransactionReceipt: vi.fn(),
};

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => mockPublicClient),
  };
});

vi.mock("permissionless/accounts", () => ({
  toSafeSmartAccount: vi.fn().mockResolvedValue({ address: FAKE_SAFE_ADDRESS }),
}));

vi.mock("permissionless", () => ({
  createSmartAccountClient: vi.fn(() => mockSmartAccountClient),
}));

vi.mock("permissionless/clients/pimlico", () => ({
  createPimlicoClient: vi.fn(() => ({
    getUserOperationGasPrice: vi.fn().mockResolvedValue({
      fast: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    }),
  })),
}));

// acquireLock returns an ownership token that releaseLock must hand back.
const LOCK_TOKEN = "lock-token-abc";

const mockDbInstance = {
  findWalletById: vi.fn(),
  updateTradeStatus: vi.fn(),
  prisma: {
    trade: { findUnique: vi.fn() },
  },
};

vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => mockDbInstance },
}));

const mockRedisInstance = {
  acquireLock: vi.fn().mockResolvedValue(LOCK_TOKEN),
  releaseLock: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../../../src/services/redis.js", () => ({
  RedisService: { getInstance: () => mockRedisInstance },
}));

const mockKmsInstance = {
  decryptPrivateKey: vi.fn().mockResolvedValue("0x" + "1".repeat(64)),
};

vi.mock("../../../src/services/kms.js", () => ({
  KMSService: { getInstance: () => mockKmsInstance },
}));

// Fully mocked — "execution" here means the non-DRY_RUN code path, not a real
// network. No RPC, bundler or paymaster is contacted.
describe("BaseAdapter execution path (DRY_RUN disabled)", () => {
  let BaseAdapter: typeof import("../../../src/services/chains/evm/baseAdapter.js").BaseAdapter;
  let adapter: import("../../../src/services/chains/evm/baseAdapter.js").BaseAdapter;

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.BASE_NETWORK = "sepolia";
    process.env.PIMLICO_API_KEY = "test-pimlico-key";
    process.env.DRY_RUN = "false"; // must be set before the one-time ConfigManager.load() below
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.load();
    ({ BaseAdapter } = await import("../../../src/services/chains/evm/baseAdapter.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisInstance.acquireLock.mockResolvedValue(LOCK_TOKEN);
    adapter = new BaseAdapter();
  });

  it("submits the batched calls as one UserOperation and releases the wallet lock", async () => {
    mockDbInstance.findWalletById.mockResolvedValue({ id: 1, encryptedKey: "enc" });
    mockSmartAccountClient.sendTransaction.mockResolvedValue("0xabc123");

    const result = await adapter.executeEvmCall({
      calls: [
        { to: "0x3333333333333333333333333333333333333333", data: "0xaaaa" },
        { to: "0x4444444444444444444444444444444444444444", data: "0xbbbb" },
      ],
      walletId: 1,
      senderAddress: FAKE_SAFE_ADDRESS,
    });

    expect(result).toEqual({ txId: "0xabc123" });
    expect(mockSmartAccountClient.sendTransaction).toHaveBeenCalledWith({
      calls: [
        { to: "0x3333333333333333333333333333333333333333", data: "0xaaaa", value: 0n },
        { to: "0x4444444444444444444444444444444444444444", data: "0xbbbb", value: 0n },
      ],
    });
    expect(mockRedisInstance.releaseLock).toHaveBeenCalledWith("wallet:1", LOCK_TOKEN);
  });

  it("returns an error and still releases the lock when sendTransaction throws", async () => {
    mockDbInstance.findWalletById.mockResolvedValue({ id: 1, encryptedKey: "enc" });
    mockSmartAccountClient.sendTransaction.mockRejectedValue(new Error("bundler rejected UserOperation"));

    const result = await adapter.executeEvmCall({
      calls: [{ to: "0x3333333333333333333333333333333333333333", data: "0x" }],
      walletId: 1,
      senderAddress: FAKE_SAFE_ADDRESS,
    });

    expect(result).toEqual({ error: "bundler rejected UserOperation" });
    expect(mockRedisInstance.releaseLock).toHaveBeenCalledWith("wallet:1", LOCK_TOKEN);
  });

  it("confirmTransaction marks a successful receipt as CONFIRMED", async () => {
    mockPublicClient.getTransactionReceipt.mockResolvedValue({ status: "success" });

    const status = await adapter.confirmTransaction("0xabc123", 42);
    expect(status).toBe("confirmed");
    expect(mockDbInstance.updateTradeStatus).toHaveBeenCalledWith(42, "CONFIRMED", "0xabc123");
  });

  it("confirmTransaction marks a reverted receipt as FAILED", async () => {
    mockPublicClient.getTransactionReceipt.mockResolvedValue({ status: "reverted" });

    const status = await adapter.confirmTransaction("0xdef456", 43);
    expect(status).toBe("failed");
    expect(mockDbInstance.updateTradeStatus).toHaveBeenCalledWith(43, "FAILED", "0xdef456", "Transaction reverted");
  });

  it("confirmTransaction reports PENDING while the receipt isn't found yet", async () => {
    mockPublicClient.getTransactionReceipt.mockRejectedValue(new Error("not found"));

    const status = await adapter.confirmTransaction("0xnotyet", 44);
    expect(status).toBe("pending");
  });
});
