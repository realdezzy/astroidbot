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

// The preference lives in ChainPreference, reached through the db helper.
// It used to be read off TradeSettings by (userId, chain), which is what
// created duplicate account-settings rows and left RiskManager reading
// whichever one the planner returned.
const findChainPreference = vi.fn();
vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({ findChainPreference }),
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

  it("is available on Stacks when VELUMX_API_KEY is configured", () => {
    process.env.VELUMX_API_KEY = "mock_velumx_key";
    ConfigManager.reset();
    ConfigManager.load();
    const { available, reason } = sponsorshipAvailability(stacksChain);
    expect(available).toBe(true);
    expect(reason).toBeNull();
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
    findChainPreference.mockResolvedValue({ sponsorGas: false });
    expect(await sponsorGasFor(1, "base:mainnet")).toBe(false);
  });

  it("defaults to sponsored when the user has never chosen", async () => {
    // Every 4337 wallet created before this toggle existed was funded on the
    // assumption gas was paid for it. Defaulting to off would strand exactly
    // those wallets: holding tokens they can't sell for want of native asset.
    findChainPreference.mockResolvedValue(null);
    expect(await sponsorGasFor(1, "base:mainnet")).toBe(true);
  });

  it("defaults to sponsored when the lookup fails", async () => {
    // A database blip must not turn into "your swap reverted for want of gas".
    findChainPreference.mockRejectedValue(new Error("db down"));
    expect(await sponsorGasFor(1, "base:mainnet")).toBe(true);
  });

  it("reads the preference for the chain it was asked about", async () => {
    findChainPreference.mockResolvedValue({ sponsorGas: true });
    await sponsorGasFor(42, "celo:mainnet");
    expect(findChainPreference).toHaveBeenCalledWith(42, "celo:mainnet");
  });

  it("inherits when the chain has a row but no opinion on sponsorship", async () => {
    // A row can exist purely to hold a slippage override. Null means inherit,
    // and the inherited answer is sponsored — not "the user said no".
    findChainPreference.mockResolvedValue({ sponsorGas: null, slippageBps: 250 });
    expect(await sponsorGasFor(1, "base:mainnet")).toBe(true);
  });
});
