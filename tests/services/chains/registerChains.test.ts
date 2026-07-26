import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigManager } from "../../../src/config.js";

/**
 * ENABLED_CHAINS is the deployment's chain list. The rule it enforces: a chain
 * that fails to register must be a startup failure, never a silent skip. A
 * silently-missing chain looks identical to one that was never configured,
 * which is exactly how the family-keyed registry hid a dropped adapter.
 */
describe("registerEnabledChains", () => {
  let registerEnabledChains: typeof import("../../../src/services/chains/registerChains.js").registerEnabledChains;
  let ChainAdapterRegistry: typeof import("../../../src/services/chains/chainAdapterRegistry.js").ChainAdapterRegistry;

  const baseEnv = { ...process.env };

  async function loadWith(env: Record<string, string>) {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    Object.assign(process.env, env);
    // load() is idempotent in production; reset so each case sees its own env.
    ConfigManager.reset();
    ConfigManager.load();
    ({ registerEnabledChains } = await import("../../../src/services/chains/registerChains.js"));
    ({ ChainAdapterRegistry } = await import("../../../src/services/chains/chainAdapterRegistry.js"));
    ChainAdapterRegistry.getInstance().reset();
  }

  beforeEach(() => {
    delete process.env.ENABLED_CHAINS;
    delete process.env.CUSTOM_EVM_CHAINS;
    delete process.env.PIMLICO_API_KEY;
  });

  afterEach(() => {
    process.env = { ...baseEnv };
  });

  it("defaults to Stacks only, leaving existing deployments unchanged", async () => {
    await loadWith({});
    registerEnabledChains();
    expect(ChainAdapterRegistry.getInstance().list().map((d) => d.chainId))
      .toEqual(["stacks:mainnet"]);
  });

  it("registers two EVM chains side by side", async () => {
    await loadWith({ ENABLED_CHAINS: "stacks:mainnet,celo:mainnet" });
    registerEnabledChains();

    const registry = ChainAdapterRegistry.getInstance();
    expect(registry.has("stacks:mainnet")).toBe(true);
    expect(registry.has("celo:mainnet")).toBe(true);
    expect(registry.get("celo:mainnet").stableSymbol).toBe("cUSD");
  });

  it("fails loudly on an unknown chain, listing what it does know", async () => {
    await loadWith({ ENABLED_CHAINS: "stacks:mainnet,nonsense:mainnet" });
    expect(() => registerEnabledChains()).toThrow(/unknown chain "nonsense:mainnet"/);
  });

  it("fails when an ERC-4337 chain is enabled without a bundler key", async () => {
    // Registering it anyway would defer the failure to every future swap.
    await loadWith({ ENABLED_CHAINS: "base:mainnet" });
    expect(() => registerEnabledChains()).toThrow(/PIMLICO_API_KEY is not set/);
  });

  it("registers an ERC-4337 chain once its key is present", async () => {
    await loadWith({ ENABLED_CHAINS: "base:mainnet", PIMLICO_API_KEY: "pim_test" });
    registerEnabledChains();
    expect(ChainAdapterRegistry.getInstance().has("base:mainnet")).toBe(true);
  });

  it("rejects an empty chain list", async () => {
    await loadWith({ ENABLED_CHAINS: "  " });
    expect(() => registerEnabledChains()).toThrow(/at least one chain/);
  });

  it("registers a chain supplied entirely through CUSTOM_EVM_CHAINS", async () => {
    // The supported path for networks whose parameters aren't settled enough
    // to hardcode — no code change, no release.
    await loadWith({
      ENABLED_CHAINS: "stacks:mainnet,arc:mainnet",
      CUSTOM_EVM_CHAINS: JSON.stringify([
        {
          chainId: "arc:mainnet",
          displayName: "ARC",
          id: 4242,
          rpcUrl: "https://rpc.arc.example",
          nativeSymbol: "ARC",
          stableSymbol: "USDC",
        },
      ]),
    });
    registerEnabledChains();

    const registry = ChainAdapterRegistry.getInstance();
    expect(registry.has("arc:mainnet")).toBe(true);
    // No DEX configured: wallets and balances work, quoting does not.
    expect(registry.tradable().map((d) => d.chainId)).not.toContain("arc:mainnet");
    expect(registry.list().map((d) => d.chainId)).toContain("arc:mainnet");
  });

  it("reports Solana as not yet implemented instead of registering a broken adapter", async () => {
    await loadWith({ ENABLED_CHAINS: "solana:mainnet" });
    expect(() => registerEnabledChains()).toThrow(/not implemented yet/);
  });
});
