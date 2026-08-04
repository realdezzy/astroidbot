import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import bs58 from "bs58";
import { ConfigManager } from "../../../src/config.js";
import { SOLANA_MAINNET } from "../../../src/services/chains/descriptors/solana.js";

const mockDb = {
  findWalletById: vi.fn(),
  updateTradeStatus: vi.fn(),
  prisma: { trade: { findUnique: vi.fn() } },
};
const mockRedis = {
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
};
const mockKms = { decryptPrivateKey: vi.fn() };

vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => mockDb },
}));
vi.mock("../../../src/services/redis.js", () => ({
  RedisService: { getInstance: () => mockRedis },
}));
vi.mock("../../../src/services/kms.js", () => ({
  KMSService: { getInstance: () => mockKms },
}));

const LOCK_TOKEN = "lock-token";

/**
 * Solana is the third execution shape, and the real test of whether the
 * family abstraction generalises past "EVM or not". If BaseChainAdapter were
 * doing its job only for EVM, this adapter would have had to reimplement
 * locking, key decryption, DRY_RUN and confirmation ageing.
 */
describe("SolanaAdapter", () => {
  let SolanaAdapter: typeof import("../../../src/services/chains/svm/solanaAdapter.js").SolanaAdapter;
  let adapter: import("../../../src/services/chains/svm/solanaAdapter.js").SolanaAdapter;
  let getSignatureStatus: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.DRY_RUN = "true";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.reset();
    ConfigManager.load();
    ({ SolanaAdapter } = await import("../../../src/services/chains/svm/solanaAdapter.js"));
    adapter = new SolanaAdapter(SOLANA_MAINNET);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.acquireLock.mockResolvedValue(LOCK_TOKEN);
    mockDb.findWalletById.mockResolvedValue({ id: 1, address: "addr", encryptedKey: "enc" });
    mockKms.decryptPrivateKey.mockResolvedValue("priv");
    // Stub the RPC so these test our confirmation logic rather than mainnet's
    // availability. getSignatureStatus returning {value:null} is exactly what
    // a real node says for a signature it has never seen.
    getSignatureStatus = vi.fn().mockResolvedValue({ value: null });
    vi.spyOn(adapter, "connection").mockReturnValue({
      getSignatureStatus,
    } as never);
  });

  it("reports the svm family and Solana's native asset", () => {
    expect(adapter.chainFamily).toBe("svm");
    expect(adapter.nativeSymbol).toBe("SOL");
    // 9, not 18 or 6 — getting this wrong misprices every balance by 10^3.
    expect(adapter.nativeDecimals).toBe(9);
    expect(adapter.chainId()).toBe("solana:mainnet");
  });

  describe("keypairs", () => {
    it("generates a base58 secret key and a base58 address", async () => {
      const { privateKey, address } = await adapter.generateWalletKeypair();
      // base58 rather than hex, so a key can move between AstroidBot and any
      // standard Solana wallet without conversion.
      expect(bs58.decode(privateKey)).toHaveLength(64);
      expect(address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    });

    it("derives the same address the generator returned", async () => {
      const { privateKey, address } = await adapter.generateWalletKeypair();
      expect(await adapter.deriveAddressFromPrivateKey(privateKey)).toBe(address);
    });

    it("accepts a hex-encoded key as well as base58", async () => {
      const { privateKey, address } = await adapter.generateWalletKeypair();
      const asHex = Buffer.from(bs58.decode(privateKey)).toString("hex");
      expect(await adapter.deriveAddressFromPrivateKey(asHex)).toBe(address);
    });

    it("rejects a key of the wrong length rather than deriving a wrong address", async () => {
      await expect(
        adapter.deriveAddressFromPrivateKey(bs58.encode(Buffer.alloc(32)))
      ).rejects.toThrow(/expected 64 bytes/);
    });

    it("rejects a key that is neither valid base58 nor hex", async () => {
      await expect(adapter.deriveAddressFromPrivateKey("not-a-key!!")).rejects.toThrow();
    });
  });

  describe("execution", () => {
    it("honours DRY_RUN without signing or sending", async () => {
      const result = await adapter.executeSvmCall({
        transactionBase64: "AAAA",
        walletId: 1,
        senderAddress: "sender",
      });
      expect(result).toEqual({ txId: "dry-run-tx-id" });
    });

    it("takes and releases the wallet lock, inherited from BaseChainAdapter", async () => {
      await adapter.executeSvmCall({
        transactionBase64: "AAAA",
        walletId: 1,
        senderAddress: "sender",
      });
      expect(mockRedis.acquireLock).toHaveBeenCalledWith("wallet:1", 90_000);
      // Compare-and-delete with the token acquire returned, so an overrunning
      // holder can't delete another job's lock.
      expect(mockRedis.releaseLock).toHaveBeenCalledWith("wallet:1", LOCK_TOKEN);
    });

    it("returns an error rather than throwing when the wallet is busy", async () => {
      mockRedis.acquireLock.mockResolvedValueOnce(null);
      const result = await adapter.executeSvmCall({
        transactionBase64: "AAAA",
        walletId: 1,
        senderAddress: "sender",
      });
      expect(result).toEqual({ error: "Wallet 1 is busy executing another transaction" });
    });

    it("refuses SPL transfers explicitly instead of silently sending SOL", async () => {
      const result = await adapter.transfer({
        walletId: 1,
        senderAddress: "sender",
        toAddress: "dest",
        amount: 1,
        token: "USDC",
      });
      expect(result).toEqual({
        error: "SPL token transfers are not implemented yet — only native SOL transfers",
      });
    });
  });

  describe("confirmation", () => {
    it("marks a dry-run transaction confirmed", async () => {
      const state = await adapter.confirmTransaction("dry-run-tx-id", 42);
      expect(state).toBe("confirmed");
      expect(mockDb.updateTradeStatus).toHaveBeenCalledWith(42, "CONFIRMED", "dry-run-tx-id");
    });

    it("ages out a transaction past the blockhash validity window", async () => {
      // A Solana blockhash expires after ~150 slots; past that the transaction
      // can never land, so polling forever would block the wallet's pending
      // guard indefinitely.
      mockDb.prisma.trade.findUnique.mockResolvedValue({
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
      });
      const state = await adapter.confirmTransaction("sig-that-never-landed", 43);
      expect(state).toBe("failed");
      expect(mockDb.updateTradeStatus).toHaveBeenCalledWith(
        43,
        "FAILED",
        "sig-that-never-landed",
        expect.stringContaining("likely dropped")
      );
    });

    it("stays pending inside the window", async () => {
      mockDb.prisma.trade.findUnique.mockResolvedValue({ createdAt: new Date() });
      expect(await adapter.confirmTransaction("recent-sig", 44)).toBe("pending");
    });

    it("marks a reverted transaction failed with the on-chain error", async () => {
      getSignatureStatus.mockResolvedValue({
        value: { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" },
      });
      expect(await adapter.confirmTransaction("bad-sig", 45)).toBe("failed");
      expect(mockDb.updateTradeStatus).toHaveBeenCalledWith(
        45, "FAILED", "bad-sig", expect.stringContaining("InstructionError")
      );
    });

    it("accepts either confirmed or finalized as success", async () => {
      getSignatureStatus.mockResolvedValue({ value: { err: null, confirmationStatus: "finalized" } });
      expect(await adapter.confirmTransaction("good-sig", 46)).toBe("confirmed");
    });

    it("stays pending while only processed, not yet confirmed", async () => {
      getSignatureStatus.mockResolvedValue({ value: { err: null, confirmationStatus: "processed" } });
      expect(await adapter.confirmTransaction("young-sig", 47)).toBe("pending");
    });
  });
});
