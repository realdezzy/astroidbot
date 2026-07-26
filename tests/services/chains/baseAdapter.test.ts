import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { ConfigManager } from "../../../src/config.js";

const FAKE_SAFE_ADDRESS = "0x2222222222222222222222222222222222222222";

const mockSmartAccountClient = {
  sendTransaction: vi.fn(),
};

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

describe("BaseAdapter Unit Tests", () => {
  let BaseAdapter: typeof import("../../../src/services/chains/evm/baseAdapter.js").BaseAdapter;
  let adapter: import("../../../src/services/chains/evm/baseAdapter.js").BaseAdapter;

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.BASE_NETWORK = "sepolia";
    process.env.PIMLICO_API_KEY = "test-pimlico-key";
    process.env.DRY_RUN = "true";
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

  it("declares chainFamily 'evm'", () => {
    expect(adapter.chainFamily).toBe("evm");
  });

  it("generateWalletKeypair returns the Safe's counterfactual address, not the owner EOA address", async () => {
    const { privateKeyHex, address } = await adapter.generateWalletKeypair();
    expect(address).toBe(FAKE_SAFE_ADDRESS);
    expect(privateKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("deriveAddressFromPrivateKey re-derives the same Safe address from an owner key", async () => {
    const address = await adapter.deriveAddressFromPrivateKey("0x" + "1".repeat(64));
    expect(address).toBe(FAKE_SAFE_ADDRESS);
  });

  it("executeEvmCall short-circuits on DRY_RUN without touching the smart account client", async () => {
    mockDbInstance.findWalletById.mockResolvedValue({ id: 1, encryptedKey: "enc" });

    const result = await adapter.executeEvmCall({
      calls: [{ to: "0x3333333333333333333333333333333333333333", data: "0x" }],
      walletId: 1,
      senderAddress: FAKE_SAFE_ADDRESS,
    });

    expect(result).toEqual({ txId: "dry-run-tx-id" });
    expect(mockSmartAccountClient.sendTransaction).not.toHaveBeenCalled();
    expect(mockRedisInstance.releaseLock).toHaveBeenCalledWith("wallet:1", LOCK_TOKEN);
  });

  it("executeEvmCall returns an error without crashing when the wallet lock is already held", async () => {
    mockRedisInstance.acquireLock.mockResolvedValueOnce(null);

    const result = await adapter.executeEvmCall({
      calls: [{ to: "0x3333333333333333333333333333333333333333", data: "0x" }],
      walletId: 1,
      senderAddress: FAKE_SAFE_ADDRESS,
    });

    expect(result).toEqual({ error: "Wallet 1 is busy executing another transaction" });
  });
});
