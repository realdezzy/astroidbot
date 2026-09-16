import { describe, it, expect } from "vitest";
import {
  stocksForChain,
  stockByContract,
  CURATED_STOCKS,
} from "../../../src/services/stocks/stockRegistry.js";

const NVDAON_MINT = "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo";

describe("stock registry", () => {
  it("keeps Solana mints exactly as published", () => {
    // Base58 is case-sensitive: a lowercased mint is a different, non-existent
    // account. Normalising it would silently produce rows nothing resolves.
    const mints = stocksForChain("solana:mainnet").map((s) => s.contractId);
    expect(mints).toContain(NVDAON_MINT);
    expect(mints).not.toContain(NVDAON_MINT.toLowerCase());
  });

  it("scopes each issuer's list to its chain", () => {
    expect(stocksForChain("base:mainnet")).toHaveLength(10);
    expect(stocksForChain("solana:mainnet").length).toBeGreaterThanOrEqual(10);
    expect(stocksForChain("celo:mainnet")).toHaveLength(0);
  });

  it("matches EVM addresses case-insensitively and Solana mints exactly", () => {
    expect(
      stockByContract("base:mainnet", "0xB20000000000000000000078EE7CE2FE4908108C")?.symbol
    ).toBe("NVDAc");
    expect(stockByContract("solana:mainnet", NVDAON_MINT)?.symbol).toBe("NVDAon");
    expect(stockByContract("solana:mainnet", NVDAON_MINT.toLowerCase())).toBeUndefined();
  });

  it("records provenance and issuer for every entry", () => {
    for (const s of CURATED_STOCKS) {
      expect(s.issuer).toBeTruthy();
      expect(s.sourceUrl).toMatch(/^https:\/\//);
    }
  });
});
