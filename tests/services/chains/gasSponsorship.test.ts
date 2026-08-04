import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConfigManager } from "../../../src/config.js";
import type { ChainDescriptor } from "../../../src/types/chain.js";

/**
 * Gas sponsorship is a per-chain, per-user choice — but only on chains that
 * can sponsor at all.
 *
 * Keeping "can this chain sponsor" and "does this user want it to" separate is
 * the point. Collapsed into one boolean, a chain with EOA custody would show a
 * toggle that silently does nothing, and the user would find out when a swap
 * reverted for want of gas.
 */

const findFirst = vi.fn();
vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({ prisma: { tradeSettings: { findFirst } } }),
  },
}));

const { sponsorshipAvailability, sponsorGasFor } = await import(
  "../../../src/services/chains/gasSponsorship.js"
);

function loadConfig(pimlicoKey?: string) {
  process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
  process.env.AES_KEY = "testkey";
  process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
  if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
  if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
  if (pimlicoKey) process.env.PIMLICO_API_KEY = pimlicoKey;
  else delete process.env.PIMLICO_API_KEY;
  ConfigManager.reset();
  ConfigManager.load();
}

const smartAccountChain = {
  chainId: "base:mainnet",
  family: "evm",
  evm: { custody: "erc4337", bundler: { slug: "base" } },
} as unknown as ChainDescriptor;

const eoaChain = {
  chainId: "celo:mainnet",
  family: "evm",
  evm: { custody: "eoa" },
} as unknown as ChainDescriptor;

const stacksChain = {
  chainId: "stacks:mainnet",
  family: "stacks",
} as unknown as ChainDescriptor;

describe("gas sponsorship availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfig("pim_key");
  });

  it("is available on a smart-account chain with a bundler and a key", () => {
    expect(sponsorshipAvailability(smartAccountChain)).toEqual({ available: true, reason: null });
  });

  it("is unavailable under EOA custody, and says why", () => {
    // An EOA pays its own gas by construction — there is no paymaster to ask.
    const { available, reason } = sponsorshipAvailability(eoaChain);
    expect(available).toBe(false);
    expect(reason).toMatch(/EOA/i);
  });

  it("is unavailable off the EVM entirely", () => {
    const { available, reason } = sponsorshipAvailability(stacksChain);
    expect(available).toBe(false);
    expect(reason).toMatch(/ERC-4337/);
  });

  it("is unavailable without a paymaster key, however the chain is configured", () => {
    // The deployment, not the chain, is what's missing — and the message has
    // to say that, or an operator debugs the descriptor instead of the env.
    loadConfig(undefined);
    const { available, reason } = sponsorshipAvailability(smartAccountChain);
    expect(available).toBe(false);
    expect(reason).toMatch(/PIMLICO_API_KEY/);
  });
});

describe("sponsorGasFor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfig("pim_key");
  });

  it("honours an explicit opt-out", async () => {
    findFirst.mockResolvedValue({ sponsorGas: false });
    expect(await sponsorGasFor(1, "base:mainnet")).toBe(false);
  });

  it("defaults to sponsored when the user has never chosen", async () => {
    // Every 4337 wallet created before this toggle existed was funded on the
    // assumption gas was paid for it. Defaulting to off would strand exactly
    // those wallets: holding tokens they can't sell for want of native asset.
    findFirst.mockResolvedValue(null);
    expect(await sponsorGasFor(1, "base:mainnet")).toBe(true);
  });

  it("defaults to sponsored when the lookup fails", async () => {
    // A database blip must not turn into "your swap reverted for want of gas".
    findFirst.mockRejectedValue(new Error("db down"));
    expect(await sponsorGasFor(1, "base:mainnet")).toBe(true);
  });

  it("reads the preference for the chain it was asked about", async () => {
    findFirst.mockResolvedValue({ sponsorGas: true });
    await sponsorGasFor(42, "celo:mainnet");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 42, chain: "celo:mainnet" } })
    );
  });
});
