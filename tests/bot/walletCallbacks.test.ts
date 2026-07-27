import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { ConfigManager } from "../../src/config.js";

/**
 * Regression tests for the Telegram wallet bug.
 *
 * router.ts called the Stacks-only generateWalletKeypair /
 * deriveAddressFromPrivateKey directly and passed no chainFamily to
 * createWallet, so a Telegram user could only ever receive a Stacks wallet —
 * every other chain was unreachable from the bot even when fully enabled and
 * working through the REST API. The duplicate check was also unscoped, though
 * the unique key is [chainFamily, address].
 */

const mockDb = {
  findUserByTelegramId: vi.fn(),
  findWalletsByUserId: vi.fn(),
  findWalletByAddress: vi.fn(),
  createWallet: vi.fn(),
};

vi.mock("../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => mockDb },
}));

vi.mock("../../src/utils/crypto.js", () => ({
  encrypt: (v: string) => `enc(${v})`,
}));

const registered = new Map<string, unknown>();

vi.mock("../../src/services/chains/chainAdapterRegistry.js", () => ({
  ChainAdapterRegistry: {
    getInstance: () => ({
      has: (id: string) => registered.has(id),
      get: (id: string) => {
        const a = registered.get(id);
        if (!a) throw new Error(`No chain adapter registered for "${id}"`);
        return a;
      },
      list: () => [...registered.values()].map((a) => (a as { descriptor: unknown }).descriptor),
      tradable: () => [...registered.values()].map((a) => (a as { descriptor: unknown }).descriptor),
    }),
  },
}));

function adapter(chainId: string, family: string, displayName: string, address: string) {
  return {
    descriptor: {
      chainId, family, displayName,
      nativeSymbol: family === "stacks" ? "STX" : "ETH",
      nativeDecimals: family === "stacks" ? 6 : 18,
      stableSymbol: family === "stacks" ? "USDCx" : "USDC",
      isTestnet: false, tradable: true,
      explorerTxUrl: (t: string) => `https://explorer/${t}`,
      explorerAddressUrl: (a: string) => `https://explorer/addr/${a}`,
    },
    chainFamily: family,
    chainId: () => chainId,
    generateWalletKeypair: vi.fn().mockResolvedValue({ privateKeyHex: "priv", address }),
    deriveAddressFromPrivateKey: vi.fn().mockResolvedValue(address),
  };
}

function makeCtx() {
  return {
    from: { id: 424242 },
    session: {} as Record<string, unknown>,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Telegram wallet provisioning", () => {
  let wallet: typeof import("../../src/bot/callbacks/wallet.js");
  const stacks = adapter("stacks:mainnet", "stacks", "Stacks", "SP123");
  const base = adapter("base:mainnet", "evm", "Base", "0x1111111111111111111111111111111111111111");

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.load();
    wallet = await import("../../src/bot/callbacks/wallet.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    registered.clear();
    registered.set("stacks:mainnet", stacks);
    registered.set("base:mainnet", base);
    mockDb.findUserByTelegramId.mockResolvedValue({ id: 7 });
    mockDb.findWalletsByUserId.mockResolvedValue([]);
    mockDb.findWalletByAddress.mockResolvedValue(null);
    mockDb.createWallet.mockImplementation(async (d: Record<string, unknown>) => ({ id: 1, ...d }));
  });

  it("creates an EVM wallet through the EVM adapter, not the Stacks helpers", async () => {
    // THE regression: this was impossible before — the bot always produced a
    // Stacks wallet regardless of which chains were enabled.
    const ctx = makeCtx();
    await wallet.createWalletOnChain(ctx as never, "base");

    expect(base.generateWalletKeypair).toHaveBeenCalled();
    expect(stacks.generateWalletKeypair).not.toHaveBeenCalled();
    expect(mockDb.createWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        chainFamily: "evm",
        chain: "base:mainnet",
        address: "0x1111111111111111111111111111111111111111",
      })
    );
  });

  it("creates a Stacks wallet when Stacks is chosen", async () => {
    const ctx = makeCtx();
    await wallet.createWalletOnChain(ctx as never, "stacks");

    expect(stacks.generateWalletKeypair).toHaveBeenCalled();
    expect(mockDb.createWallet).toHaveBeenCalledWith(
      expect.objectContaining({ chainFamily: "stacks", chain: "stacks:mainnet" })
    );
  });

  it("refuses a chain the deployment has not enabled", async () => {
    registered.delete("base:mainnet");
    const ctx = makeCtx();
    await wallet.createWalletOnChain(ctx as never, "base");

    expect(mockDb.createWallet).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/not enabled/);
  });

  it("records the chosen chain before asking for an imported key", async () => {
    const ctx = makeCtx();
    await wallet.promptKeyForChain(ctx as never, "base");

    expect(ctx.session.importChainId).toBe("base:mainnet");
    expect(ctx.session.waitingFor).toBe("import_wallet");
    // The prompt names the chain, so a user can't paste a Stacks key into a
    // Base import without noticing.
    expect(ctx.reply.mock.calls[0]![0]).toContain("Base");
  });

  it("derives an imported key through the chosen chain's adapter", async () => {
    const ctx = makeCtx();
    ctx.session.importChainId = "base:mainnet";
    await wallet.importWalletKey(ctx as never, "0xdeadbeef");

    expect(base.deriveAddressFromPrivateKey).toHaveBeenCalledWith("0xdeadbeef");
    expect(stacks.deriveAddressFromPrivateKey).not.toHaveBeenCalled();
    expect(ctx.session.waitingFor).toBe("import_wallet_name");
  });

  it("scopes the import duplicate check to the chain's family", async () => {
    // The unique key is [chainFamily, address]; an unscoped check rejects a
    // legitimate import of the same address on a different chain.
    const ctx = makeCtx();
    ctx.session.importChainId = "base:mainnet";
    await wallet.importWalletKey(ctx as never, "0xdeadbeef");

    expect(mockDb.findWalletByAddress).toHaveBeenCalledWith(
      "0x1111111111111111111111111111111111111111",
      "evm"
    );
  });

  it("reports an invalid key against the chain that rejected it", async () => {
    base.deriveAddressFromPrivateKey.mockRejectedValueOnce(new Error("bad key"));
    const ctx = makeCtx();
    ctx.session.importChainId = "base:mainnet";
    await wallet.importWalletKey(ctx as never, "not-a-key");

    expect(ctx.reply.mock.calls[0]![0]).toContain("Base");
    expect(mockDb.createWallet).not.toHaveBeenCalled();
  });

  it("persists the chain when the imported wallet is finally named", async () => {
    const ctx = makeCtx();
    ctx.session.importChainId = "base:mainnet";
    ctx.session.tempAddress = "0x1111111111111111111111111111111111111111";
    ctx.session.tempPrivateKey = "enc(priv)";

    await wallet.saveImportedWallet(ctx as never, "My Base Wallet");

    expect(mockDb.createWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "My Base Wallet",
        chainFamily: "evm",
        chain: "base:mainnet",
      })
    );
    // Chain state is cleared so the next import starts from the picker.
    expect(ctx.session.importChainId).toBeUndefined();
  });

  it("defaults an import with no recorded chain to Stacks, preserving old behaviour", async () => {
    const ctx = makeCtx();
    await wallet.importWalletKey(ctx as never, "somekey");
    expect(stacks.deriveAddressFromPrivateKey).toHaveBeenCalled();
  });
});
