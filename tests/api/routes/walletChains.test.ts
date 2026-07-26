import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createServer } from "../../../src/api/server.js";
import { ConfigManager } from "../../../src/config.js";
import type { Server } from "node:http";

// Wallet provisioning across chain families. Before this path existed,
// generate/import called the Stacks keypair helpers directly and createWallet
// had no chainFamily column to write, so an EVM wallet could never be created
// and the whole Base execution path was unreachable in production.

const mockDbInstance = {
  healthCheck: vi.fn().mockResolvedValue(true),
  findWalletsByUserId: vi.fn().mockResolvedValue([]),
  findWalletByAddress: vi.fn().mockResolvedValue(null),
  createWallet: vi.fn(),
  updateWalletBalance: vi.fn(),
};

const mockRegistryInstance = {
  getSwappableTokens: vi.fn().mockResolvedValue([]),
  getTokenPrice: vi.fn().mockResolvedValue(0),
};

const mockPmInstance = {
  fetchBalances: vi.fn().mockResolvedValue([]),
};

const stacksAdapter = {
  descriptor: {
    chainId: "stacks:mainnet", family: "stacks", displayName: "Stacks",
    nativeSymbol: "STX", nativeDecimals: 6, stableSymbol: "USDCx",
    isTestnet: false, tradable: true,
  },
  chainFamily: "stacks",
  nativeSymbol: "STX",
  nativeDecimals: 6,
  stableSymbol: "USDCx",
  chainId: () => "stacks:mainnet",
  generateWalletKeypair: vi.fn(),
  deriveAddressFromPrivateKey: vi.fn(),
};

const evmAdapter = {
  descriptor: {
    chainId: "base:sepolia", family: "evm", displayName: "Base Sepolia",
    nativeSymbol: "ETH", nativeDecimals: 18, stableSymbol: "USDC",
    isTestnet: true, tradable: true,
  },
  chainFamily: "evm",
  nativeSymbol: "ETH",
  nativeDecimals: 18,
  stableSymbol: "USDC",
  chainId: () => "base:sepolia",
  generateWalletKeypair: vi.fn(),
  deriveAddressFromPrivateKey: vi.fn(),
};

const registeredAdapters = new Map<string, unknown>();

vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => mockDbInstance },
}));

vi.mock("../../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: { getInstance: () => mockRegistryInstance },
}));

vi.mock("../../../src/services/portfolio.js", () => ({
  PortfolioManager: { getInstance: () => mockPmInstance },
}));

vi.mock("../../../src/services/chains/chainAdapterRegistry.js", () => ({
  ChainAdapterRegistry: {
    getInstance: () => ({
      has: (chainId: string) => registeredAdapters.has(chainId),
      get: (chainId: string) => {
        const a = registeredAdapters.get(chainId);
        if (!a) throw new Error(`No chain adapter registered for "${chainId}"`);
        return a;
      },
      list: () => [...registeredAdapters.values()].map((a) => (a as { descriptor: unknown }).descriptor),
    }),
  },
}));

vi.mock("../../../src/services/redis.js", () => ({
  RedisService: { getInstance: () => ({ get: vi.fn(), set: vi.fn() }) },
}));

vi.mock("../../../src/services/queue.js", () => ({
  QueueManager: {
    getInstance: () => ({
      getQueue: () => ({ client: Promise.resolve({ ping: () => Promise.resolve("PONG") }) }),
    }),
  },
  QUEUES: { TRADE_EXECUTION: "TRADE_EXECUTION" },
}));

vi.mock("../../../src/services/telegram.js", () => ({
  TelegramService: { getInstance: () => ({ getWebhookPath: () => null }) },
}));

vi.mock("../../../src/api/websocket.js", () => ({
  WebSocketManager: {
    getInstance: () => ({ initialize: vi.fn(), getConnectedCount: () => 0 }),
  },
}));

describe("Wallet provisioning across chain families", () => {
  let server: Server;
  let token: string;

  beforeAll(() => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    // Must be a real base64-encoded 32-byte key: these routes encrypt the
    // generated/imported private key before persisting it.
    process.env.AES_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.PORT = "8017";
    process.env.DRY_RUN = "true";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.load();
    server = createServer();
    token = jwt.sign({ userId: 10 }, ConfigManager.getInstance().config.JWT_SECRET);
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    registeredAdapters.clear();
    registeredAdapters.set("stacks:mainnet", stacksAdapter);
    mockDbInstance.findWalletsByUserId.mockResolvedValue([]);
    mockDbInstance.findWalletByAddress.mockResolvedValue(null);
    mockRegistryInstance.getSwappableTokens.mockResolvedValue([]);
    mockRegistryInstance.getTokenPrice.mockResolvedValue(0);
    mockPmInstance.fetchBalances.mockResolvedValue([]);
  });

  it("defaults to a stacks wallet when no chain is given", async () => {
    stacksAdapter.generateWalletKeypair.mockResolvedValue({
      privateKeyHex: "a".repeat(64),
      address: "SP123",
    });
    mockDbInstance.createWallet.mockImplementation(async (d: Record<string, unknown>) => ({
      id: 1, ...d, balance: 0, isDefault: true, createdAt: new Date(),
    }));

    const res = await request(server)
      .post("/api/me/wallets/generate")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "My Wallet" });

    expect(res.status).toBe(201);
    expect(res.body.chainFamily).toBe("stacks");
    expect(mockDbInstance.createWallet).toHaveBeenCalledWith(
      expect.objectContaining({ chainFamily: "stacks", chain: "stacks:mainnet", address: "SP123" })
    );
  });

  it("generates an EVM wallet through the evm adapter when Base is enabled", async () => {
    registeredAdapters.set("base:sepolia", evmAdapter);
    evmAdapter.generateWalletKeypair.mockResolvedValue({
      privateKeyHex: "0x" + "b".repeat(64),
      address: "0x1111111111111111111111111111111111111111",
    });
    mockDbInstance.createWallet.mockImplementation(async (d: Record<string, unknown>) => ({
      id: 2, ...d, balance: 0, isDefault: false, createdAt: new Date(),
    }));

    const res = await request(server)
      .post("/api/me/wallets/generate")
      .set("Authorization", `Bearer ${token}`)
      .send({ chainId: "base:sepolia" });

    expect(res.status).toBe(201);
    expect(evmAdapter.generateWalletKeypair).toHaveBeenCalled();
    expect(stacksAdapter.generateWalletKeypair).not.toHaveBeenCalled();
    // The Safe's counterfactual address is persisted, not the owner EOA.
    expect(mockDbInstance.createWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        chainFamily: "evm",
        chain: "base:sepolia",
        address: "0x1111111111111111111111111111111111111111",
      })
    );
  });

  it("rejects a chain the deployment has not enabled instead of silently using stacks", async () => {
    // base:sepolia is absent from ENABLED_CHAINS, so no adapter is registered.
    const res = await request(server)
      .post("/api/me/wallets/generate")
      .set("Authorization", `Bearer ${token}`)
      .send({ chainId: "base:sepolia" });

    expect(res.status).toBe(422);
    expect(mockDbInstance.createWallet).not.toHaveBeenCalled();
  });

  it("scopes the import duplicate check to the wallet's own chain family", async () => {
    registeredAdapters.set("base:sepolia", evmAdapter);
    evmAdapter.deriveAddressFromPrivateKey.mockResolvedValue(
      "0x2222222222222222222222222222222222222222"
    );
    mockDbInstance.createWallet.mockImplementation(async (d: Record<string, unknown>) => ({
      id: 3, ...d, balance: 0, isDefault: false, createdAt: new Date(),
    }));

    const res = await request(server)
      .post("/api/me/wallets/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ privateKey: "0x" + "c".repeat(64), chainId: "base:sepolia" });

    expect(res.status).toBe(201);
    expect(mockDbInstance.findWalletByAddress).toHaveBeenCalledWith(
      "0x2222222222222222222222222222222222222222",
      "evm"
    );
  });

  it("reports an invalid key against the chain that rejected it", async () => {
    registeredAdapters.set("base:sepolia", evmAdapter);
    evmAdapter.deriveAddressFromPrivateKey.mockRejectedValue(new Error("invalid private key"));

    const res = await request(server)
      .post("/api/me/wallets/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ privateKey: "0x" + "d".repeat(64), chainId: "base:sepolia" });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("Base Sepolia");
    expect(mockDbInstance.createWallet).not.toHaveBeenCalled();
  });
});
