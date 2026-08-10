import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConfigManager } from "../../../src/config.js";
import type { ChainDescriptor } from "../../../src/types/chain.js";

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
  if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = "sk-dummy-key-for-test";
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
    findChainPreference.mockResolvedValue(null);
    expect(await sponsorGasFor(1, "base:mainnet")).toBe(true);
  });

  it("defaults to sponsored when the lookup fails", async () => {
    findChainPreference.mockRejectedValue(new Error("db down"));
    expect(await sponsorGasFor(1, "base:mainnet")).toBe(true);
  });

  it("reads the preference for the chain it was asked about", async () => {
    findChainPreference.mockResolvedValue({ sponsorGas: true });
    await sponsorGasFor(42, "celo:mainnet");
    expect(findChainPreference).toHaveBeenCalledWith(42, "celo:mainnet");
  });

  it("inherits when the chain has a row but no opinion on sponsorship", async () => {
    findChainPreference.mockResolvedValue({ sponsorGas: null, slippageBps: 250 });
    expect(await sponsorGasFor(1, "base:mainnet")).toBe(true);
  });
});
