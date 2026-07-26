import { describe, it, expect, beforeEach, vi } from "vitest";
import { DEXRegistry } from "../../../src/services/dex/dexRegistry.js";
import type { DEXProvider } from "../../../src/types/dexProvider.js";

// The registry aggregates across every registered provider. Once providers span
// chain families, an unscoped aggregate is wrong for any single wallet: a Base
// wallet must not be quoted or priced by a Stacks DEX, and a symbol listed on
// both chains ("USDC") is two different assets with different contract ids.

function makeProvider(
  name: string,
  chainFamily: string | undefined,
  tokens: Array<{ contractId: string; symbol: string; decimals: number }>,
  price: number
): DEXProvider {
  const full = tokens.map((t) => ({ ...t, name: t.symbol }));
  return {
    name,
    ...(chainFamily ? { chainFamily } : {}),
    getSwappableTokens: vi.fn().mockResolvedValue(full),
    getCachedTokens: () => full,
    hasRoute: vi.fn().mockResolvedValue(true),
    getQuote: vi.fn().mockResolvedValue({ amountOut: 100, priceImpact: 0, feeBps: 30, feeAmount: 0 }),
    getTokenPrice: vi.fn().mockResolvedValue(price),
    buildSwapPayload: vi.fn().mockResolvedValue(null),
    getTradingPairs: () => [],
  } as unknown as DEXProvider;
}

describe("DEXRegistry chain scoping", () => {
  let registry: DEXRegistry;

  beforeEach(() => {
    // Reset the singleton so each test starts with a known provider set.
    (DEXRegistry as unknown as { instance?: DEXRegistry }).instance = undefined;
    registry = DEXRegistry.getInstance();
    registry.registerProvider(
      makeProvider("StacksDex", undefined, [
        { contractId: "SP123.usdc-token", symbol: "USDC", decimals: 6 },
        { contractId: "SP123.alex-token", symbol: "ALEX", decimals: 8 },
      ], 0.5)
    );
    registry.registerProvider(
      makeProvider("EvmDex", "evm", [
        { contractId: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
        { contractId: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
      ], 3000)
    );
  });

  it("treats a provider with no declared chainFamily as stacks", () => {
    expect(registry.getProvidersForChain("stacks").map((p) => p.name)).toEqual(["StacksDex"]);
    expect(registry.getProvidersForChain("evm").map((p) => p.name)).toEqual(["EvmDex"]);
  });

  it("keeps same-symbol tokens on different chains as separate entries", async () => {
    const all = await registry.getSwappableTokens();
    const usdcs = all.filter((t) => t.symbol === "USDC");

    expect(usdcs).toHaveLength(2);
    expect(usdcs.map((t) => t.chainFamily).sort()).toEqual(["evm", "stacks"]);
    // Critically, the Stacks entry must not have been overwritten with the
    // Base contract id (or vice versa) by symbol-keyed dedup.
    expect(usdcs.find((t) => t.chainFamily === "stacks")!.contractId).toBe("SP123.usdc-token");
    expect(usdcs.find((t) => t.chainFamily === "evm")!.contractId).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    );
  });

  it("returns only the requested chain's tokens when scoped", async () => {
    const evmTokens = await registry.getSwappableTokens(false, "evm");
    expect(evmTokens.map((t) => t.symbol).sort()).toEqual(["USDC", "WETH"]);

    const stacksTokens = await registry.getSwappableTokens(false, "stacks");
    expect(stacksTokens.map((t) => t.symbol).sort()).toEqual(["ALEX", "USDC"]);
  });

  it("scopes getCachedTokens the same way", () => {
    expect(registry.getCachedTokens("evm").map((t) => t.symbol).sort()).toEqual(["USDC", "WETH"]);
    expect(registry.getCachedTokens().filter((t) => t.symbol === "USDC")).toHaveLength(2);
  });

  it("prices a symbol against the requested chain, not whichever provider registered first", async () => {
    // Unscoped, the Stacks provider answers first and reports 0.5.
    await expect(registry.getTokenPrice("USDC")).resolves.toBe(0.5);
    await expect(registry.getTokenPrice("USDC", "evm")).resolves.toBe(3000);
    await expect(registry.getTokenPrice("USDC", "stacks")).resolves.toBe(0.5);
  });

  it("does not quote a chain's pair using another chain's DEX", async () => {
    const best = await registry.getBestQuote("USDC", "WETH", 1, "evm");
    expect(best?.providerName).toBe("EvmDex");

    // A family with no registered providers yields no quote rather than
    // falling back to an unrelated chain's DEX.
    await expect(registry.getBestQuote("USDC", "WETH", 1, "solana")).resolves.toBeNull();
  });
});
