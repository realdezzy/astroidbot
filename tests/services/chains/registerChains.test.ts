import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigManager } from "../../../src/config.js";

describe("registerEnabledChains", { timeout: 30_000 }, () => {
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
    if (ChainAdapterRegistry) ChainAdapterRegistry.getInstance().reset();
  });

  afterEach(() => {
    process.env = { ...baseEnv };
  });

  it("defaults to a multichain deployment", async () => {
    await loadWith({});
    registerEnabledChains();
    expect(ChainAdapterRegistry.getInstance().list().map((d) => d.chainId))
      .toEqual(["stacks:mainnet", "base:mainnet", "robinhood:mainnet", "solana:mainnet"]);
  });

  it("ships two EVM chains by default, not one", async () => {
    await loadWith({});
    registerEnabledChains();

    const evm = ChainAdapterRegistry.getInstance()
      .list()
      .filter((d) => d.family === "evm")
      .map((d) => d.chainId);
    expect(evm).toEqual(["base:mainnet", "robinhood:mainnet"]);
  });

  it("names each chain's actually-traded stablecoin", async () => {
    await loadWith({});
    registerEnabledChains();

    const registry = ChainAdapterRegistry.getInstance();
    expect(registry.get("robinhood:mainnet").descriptor.stableSymbol).toBe("USDG");
    expect(registry.get("base:mainnet").descriptor.stableSymbol).toBe("USDC");
  });

  it("declares a token entry for every chain's stablecoin", async () => {
    await loadWith({ ENABLED_CHAINS: "base:mainnet,robinhood:mainnet,celo:mainnet" });
    registerEnabledChains();

    for (const d of ChainAdapterRegistry.getInstance().list()) {
      if (d.family !== "evm") continue;
      expect(Object.keys(d.evm?.tokens ?? {})).toContain(d.stableSymbol);
    }
  });

  it("registers two EVM chains side by side", async () => {
    await loadWith({ ENABLED_CHAINS: "stacks:mainnet,celo:mainnet" });
    registerEnabledChains();

    const registry = ChainAdapterRegistry.getInstance();
    expect(registry.has("stacks:mainnet")).toBe(true);
    expect(registry.has("celo:mainnet")).toBe(true);
    expect(registry.get("celo:mainnet").stableSymbol).toBe("USDm");
  });

  it("fails loudly on an unknown chain, listing what it does know", async () => {
    await loadWith({ ENABLED_CHAINS: "stacks:mainnet,nonsense:mainnet" });
    expect(() => registerEnabledChains()).toThrow(/unknown chain "nonsense:mainnet"/);
  });

  it("runs an ERC-4337 chain as an EOA when there is no paymaster key", async () => {
    await loadWith({ ENABLED_CHAINS: "base:mainnet" });
    registerEnabledChains();

    const registry = ChainAdapterRegistry.getInstance();
    expect(registry.has("base:mainnet")).toBe(true);
    expect(registry.get("base:mainnet").descriptor.evm?.custody).toBe("eoa");
  });

  it("uses ERC-4337 custody once the key is present", async () => {
    await loadWith({ ENABLED_CHAINS: "base:mainnet", PIMLICO_API_KEY: "pim_test" });
    registerEnabledChains();

    const registry = ChainAdapterRegistry.getInstance();
    expect(registry.has("base:mainnet")).toBe(true);
    expect(registry.get("base:mainnet").descriptor.evm?.custody).toBe("erc4337");
  });

  it("does not mutate the shared descriptor when it downgrades custody", async () => {
    await loadWith({ ENABLED_CHAINS: "base:mainnet" });
    registerEnabledChains();

    const { BUILT_IN_DESCRIPTORS } = await import(
      "../../../src/services/chains/descriptors/index.js"
    );
    const base = BUILT_IN_DESCRIPTORS.find((d) => d.chainId === "base:mainnet");
    expect(base?.evm?.custody).toBe("erc4337");
  });

  it("is multichain by default — one chain per execution family", async () => {
    await loadWith({});
    registerEnabledChains();

    const families = new Set(
      ChainAdapterRegistry.getInstance().list().map((d) => d.family)
    );
    expect(families).toEqual(new Set(["stacks", "evm", "svm"]));
  });

  it("boots with no credentials configured at all", async () => {
    await loadWith({});
    expect(() => registerEnabledChains()).not.toThrow();
  });

  it("rejects an empty chain list", async () => {
    await loadWith({ ENABLED_CHAINS: "  " });
    expect(() => registerEnabledChains()).toThrow(/at least one chain/);
  });

  it("registers a chain supplied entirely through CUSTOM_EVM_CHAINS", async () => {
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
    expect(registry.tradable().map((d) => d.chainId)).not.toContain("arc:mainnet");
    expect(registry.list().map((d) => d.chainId)).toContain("arc:mainnet");
  });

  it("registers Solana alongside EVM and Stacks — three families at once", async () => {
    await loadWith({ ENABLED_CHAINS: "stacks:mainnet,celo:mainnet,solana:mainnet" });
    registerEnabledChains();

    const registry = ChainAdapterRegistry.getInstance();
    expect(registry.forFamily("stacks")).toHaveLength(1);
    expect(registry.forFamily("evm")).toHaveLength(1);
    expect(registry.forFamily("svm")).toHaveLength(1);
    expect(registry.get("solana:mainnet").nativeSymbol).toBe("SOL");
    expect(registry.get("solana:mainnet").nativeDecimals).toBe(9);
  });

  it("registers Solana devnet as listable but not tradable", async () => {
    await loadWith({ ENABLED_CHAINS: "solana:devnet" });
    registerEnabledChains();

    const registry = ChainAdapterRegistry.getInstance();
    expect(registry.has("solana:devnet")).toBe(true);
    expect(registry.tradable().map((d) => d.chainId)).not.toContain("solana:devnet");
  });
});
