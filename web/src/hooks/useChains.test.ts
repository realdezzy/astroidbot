import { describe, it, expect } from "vitest";
import { chainLabel, nativeSymbolOf, type ChainInfo } from "./useChains";

/**
 * The two helpers that exist so no client hardcodes a chain.
 *
 * Every surface reads them instead of assuming Stacks: four components once
 * composed Hiro explorer URLs by hand, so every non-Stacks trade linked to a
 * 404, and balances were labelled "STX" on chains that have never heard of it.
 * Both functions are pure and were untested, which for the frontend's
 * chain-awareness rules is the whole of the enforcement.
 */

const chains: ChainInfo[] = [
  { chainId: "base:mainnet", displayName: "Base", nativeSymbol: "ETH", tradable: true } as ChainInfo,
  { chainId: "arc:mainnet", displayName: "Arc", nativeSymbol: "USDC", tradable: true } as ChainInfo,
];

describe("chainLabel", () => {
  it("prefers the descriptor's display name", () => {
    expect(chainLabel("base:mainnet", chains)).toBe("Base");
  });

  it("derives a readable name for a chain the API did not list", () => {
    // A chain the build knows but this deployment has not enabled still has to
    // render as something, and "celo:mainnet" in a sentence is worse than
    // "Celo".
    expect(chainLabel("celo:mainnet", chains)).toBe("Celo");
  });

  it("says so when there is no chain rather than guessing one", () => {
    expect(chainLabel(null, chains)).toBe("Unknown chain");
    expect(chainLabel(undefined, chains)).toBe("Unknown chain");
  });
});

describe("nativeSymbolOf", () => {
  it("reads the ticker off the descriptor", () => {
    expect(nativeSymbolOf("base:mainnet", chains)).toBe("ETH");
  });

  it("does not assume EVM means ETH", () => {
    // Arc's gas token is USDC. This is the case that makes a hardcoded default
    // wrong on a chain this build enables by default.
    expect(nativeSymbolOf("arc:mainnet", chains)).toBe("USDC");
  });

  it("returns empty rather than a plausible wrong ticker", () => {
    // Empty renders as visibly incomplete. "STX" — the old default — renders as
    // correct and is not, which is the failure worth preventing.
    expect(nativeSymbolOf("solana:mainnet", chains)).toBe("");
    expect(nativeSymbolOf(null, chains)).toBe("");
  });
});
