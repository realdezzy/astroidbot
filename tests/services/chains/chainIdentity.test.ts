import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { ConfigManager } from "../../../src/config.js";
import type { ChainDescriptor } from "../../../src/types/chain.js";
import type { ChainAdapter } from "../../../src/types/chainAdapter.js";
import type { DEXProvider } from "../../../src/types/dexProvider.js";

/**
 * Regression tests for the chain-identity split.
 *
 * The bug these exist to prevent: ChainAdapterRegistry used to key on
 * chainFamily and `return` early on a duplicate, so registering a second EVM
 * chain silently did nothing — no error, no log, and every wallet on that
 * chain dispatched through the first EVM adapter instead. DEXRegistry had the
 * matching flaw, matching every EVM DEX on every EVM chain.
 */

function descriptor(over: Partial<ChainDescriptor> & Pick<ChainDescriptor, "chainId">): ChainDescriptor {
  return {
    family: "evm",
    displayName: over.chainId,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    stableSymbol: "USDC",
    isTestnet: false,
    tradable: true,
    explorerTxUrl: (t: string) => t,
    explorerAddressUrl: (a: string) => a,
    ...over,
  };
}

function fakeAdapter(d: ChainDescriptor): ChainAdapter {
  return {
    descriptor: d,
    chainFamily: d.family,
    nativeSymbol: d.nativeSymbol,
    nativeDecimals: d.nativeDecimals,
    stableSymbol: d.stableSymbol,
    chainId: () => d.chainId,
    generateWalletKeypair: async () => ({ privateKeyHex: "0x", address: "0x" }),
    deriveAddressFromPrivateKey: async () => "0x",
    transfer: async () => ({ txId: "0x" }),
    confirmTransaction: async () => "confirmed" as const,
  };
}

/** Minimal DEXProvider stand-in — only the fields chain scoping reads. */
type FakeProvider = Pick<
  DEXProvider,
  "name" | "chainFamily" | "chainId" | "getSwappableTokens" | "getCachedTokens"
  | "hasRoute" | "getQuote" | "getTokenPrice" | "buildSwapPayload"
>;

describe("Chain identity", () => {
  let ChainAdapterRegistry: typeof import("../../../src/services/chains/chainAdapterRegistry.js").ChainAdapterRegistry;
  let DEXRegistry: typeof import("../../../src/services/dex/dexRegistry.js").DEXRegistry;

  const BASE = descriptor({ chainId: "base:mainnet", displayName: "Base" });
  const CELO = descriptor({ chainId: "celo:mainnet", displayName: "Celo", nativeSymbol: "CELO", stableSymbol: "cUSD" });
  const STACKS = descriptor({
    chainId: "stacks:mainnet", family: "stacks", displayName: "Stacks",
    nativeSymbol: "STX", nativeDecimals: 6, stableSymbol: "USDCx",
  });

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.load();
    ({ ChainAdapterRegistry } = await import("../../../src/services/chains/chainAdapterRegistry.js"));
    ({ DEXRegistry } = await import("../../../src/services/dex/dexRegistry.js"));
  });

  beforeEach(() => {
    ChainAdapterRegistry.getInstance().reset();
  });

  describe("ChainAdapterRegistry", () => {
    it("holds two EVM chains at once, each resolvable to its own adapter", () => {
      // THE regression test. Under the family-keyed registry, Celo was
      // silently dropped here and celo:mainnet resolved to Base's adapter.
      const registry = ChainAdapterRegistry.getInstance();
      registry.register(fakeAdapter(BASE));
      registry.register(fakeAdapter(CELO));

      expect(registry.has("base:mainnet")).toBe(true);
      expect(registry.has("celo:mainnet")).toBe(true);
      expect(registry.get("celo:mainnet").descriptor.displayName).toBe("Celo");
      expect(registry.get("base:mainnet").descriptor.displayName).toBe("Base");
      expect(registry.get("celo:mainnet").stableSymbol).toBe("cUSD");
    });

    it("indexes by family without collapsing distinct chains", () => {
      const registry = ChainAdapterRegistry.getInstance();
      registry.register(fakeAdapter(BASE));
      registry.register(fakeAdapter(CELO));
      registry.register(fakeAdapter(STACKS));

      expect(registry.forFamily("evm").map((a) => a.descriptor.chainId).sort())
        .toEqual(["base:mainnet", "celo:mainnet"]);
      expect(registry.forFamily("stacks")).toHaveLength(1);
      expect(registry.forFamily("svm")).toHaveLength(0);
    });

    it("throws on duplicate registration rather than silently ignoring it", () => {
      // A chain that fails to register is indistinguishable from one that was
      // never configured — which is exactly how the original bug hid.
      const registry = ChainAdapterRegistry.getInstance();
      registry.register(fakeAdapter(BASE));
      expect(() => registry.register(fakeAdapter(BASE))).toThrow(/Duplicate chain adapter/);
    });

    it("names the registered chains when asked for one that isn't there", () => {
      const registry = ChainAdapterRegistry.getInstance();
      registry.register(fakeAdapter(BASE));
      expect(() => registry.get("celo:mainnet")).toThrow(/base:mainnet/);
    });

    it("reports tradable chains separately from registered ones", () => {
      const registry = ChainAdapterRegistry.getInstance();
      registry.register(fakeAdapter(BASE));
      registry.register(fakeAdapter(descriptor({ chainId: "arc:mainnet", tradable: false })));

      expect(registry.list()).toHaveLength(2);
      expect(registry.tradable().map((d) => d.chainId)).toEqual(["base:mainnet"]);
    });
  });

  describe("resolveChainId", () => {
    it("prefers the wallet's concrete chain over its family", () => {
      const registry = ChainAdapterRegistry.getInstance();
      registry.register(fakeAdapter(CELO));
      expect(registry.resolveChainId({ chain: "celo:mainnet", chainFamily: "evm" })).toBe("celo:mainnet");
    });

    it("falls back to the family default for rows written before the chain column", () => {
      const registry = ChainAdapterRegistry.getInstance();
      expect(registry.resolveChainId({ chainFamily: "stacks" })).toBe("stacks:mainnet");
      expect(registry.resolveChainId({ chainFamily: "evm" })).toBe("base:mainnet");
      expect(registry.resolveChainId({})).toBe("stacks:mainnet");
    });

    it("returns a disabled chain as-is instead of substituting a default", () => {
      // Substituting here would execute a Celo wallet's trade on Base.
      const registry = ChainAdapterRegistry.getInstance();
      expect(registry.resolveChainId({ chain: "celo:mainnet", chainFamily: "evm" })).toBe("celo:mainnet");
    });
  });

  describe("DEXRegistry chain scoping", () => {
    function fakeProvider(name: string, chainId: string, family = "evm"): FakeProvider {
      return {
        name,
        chainFamily: family,
        chainId,
        getSwappableTokens: async () => [
          { contractId: `0x${name}`, symbol: "USDC", name: "USD Coin", decimals: 6 },
        ],
        getCachedTokens: () => [
          { contractId: `0x${name}`, symbol: "USDC", name: "USD Coin", decimals: 6 },
        ],
        hasRoute: async () => true,
        getQuote: async () => ({ amountOut: 1, priceImpact: 0, feeBps: 30, feeAmount: 0 }),
        getTokenPrice: async () => 1,
        buildSwapPayload: async () => null,
      };
    }

    beforeEach(() => {
      // DEXRegistry is a singleton with no reset; clear its provider list.
      (DEXRegistry.getInstance() as unknown as { providers: unknown[] }).providers = [];
    });

    it("scopes providers to one network, not one family", () => {
      const registry = DEXRegistry.getInstance();
      registry.registerProvider(fakeProvider("UniswapV3-base", "base:mainnet"));
      registry.registerProvider(fakeProvider("Ubeswap-celo", "celo:mainnet"));

      // The D2 regression: scoping by "evm" matched both, so a Base wallet
      // could be quoted by Celo's router.
      expect(registry.getProvidersForChain("base:mainnet").map((p) => p.name))
        .toEqual(["UniswapV3-base"]);
      expect(registry.getProvidersForChain("celo:mainnet").map((p) => p.name))
        .toEqual(["Ubeswap-celo"]);
    });

    it("still matches every provider in a family when handed a bare family", () => {
      const registry = DEXRegistry.getInstance();
      registry.registerProvider(fakeProvider("UniswapV3-base", "base:mainnet"));
      registry.registerProvider(fakeProvider("Ubeswap-celo", "celo:mainnet"));

      expect(registry.getProvidersForChain("evm")).toHaveLength(2);
    });

    it("treats a provider with no declared chainId as its family's default network", () => {
      const registry = DEXRegistry.getInstance();
      registry.registerProvider({ ...fakeProvider("Alex", "", "stacks"), chainId: undefined });
      expect(registry.getProvidersForChain("stacks:mainnet").map((p) => p.name)).toEqual(["Alex"]);
    });

    it("keeps same-ticker tokens on different chains distinct", async () => {
      const registry = DEXRegistry.getInstance();
      registry.registerProvider(fakeProvider("UniswapV3-base", "base:mainnet"));
      registry.registerProvider(fakeProvider("Ubeswap-celo", "celo:mainnet"));

      // Both list "USDC" at different addresses. Merging them by symbol alone
      // would hand callers the wrong chain's contract.
      const tokens = await registry.getSwappableTokens(false);
      expect(tokens).toHaveLength(2);
      expect(tokens.map((t) => t.chainId).sort()).toEqual(["base:mainnet", "celo:mainnet"]);
    });
  });
});
