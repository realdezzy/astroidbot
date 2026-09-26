import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadTestConfig } from "../../helpers/config.js";
import type { GeckoPool, GeckoTokenMetrics } from "../../../src/services/geckoTerminal.js";

const api = vi.hoisted(() => ({
  tokenMetrics: vi.fn(),
  topPools: vi.fn(),
  newPools: vi.fn(),
  searchPools: vi.fn(),
  trades: vi.fn(),
}));

vi.mock("../../../src/services/geckoTerminal.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/services/geckoTerminal.js")>(
    "../../../src/services/geckoTerminal.js"
  );
  return { ...actual, GeckoTerminalService: { getInstance: () => api } };
});

const { GeckoTerminalMarketDataProvider } = await import(
  "../../../src/services/marketData/geckoTerminalProvider.js"
);

function token(over: Partial<GeckoTokenMetrics> = {}): GeckoTokenMetrics {
  return {
    address: "0xabc",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    imageUrl: null,
    priceUsd: 2500,
    volume24h: 1000,
    liquidityUsd: 50_000,
    marketCapUsd: null,
    ...over,
  };
}

function pool(over: Partial<GeckoPool> = {}): GeckoPool {
  return {
    address: "0xpool",
    network: "base",
    name: "WETH / USDC 0.05%",
    dexId: "uniswap_v3",
    baseTokenAddress: "0xabc",
    reserveUsd: 500_000,
    volume24h: 900,
    priceUsd: 2500,
    priceChange5m: 1,
    priceChange1h: 2,
    priceChange6h: 3,
    priceChange24h: 4,
    buys24h: 12,
    sells24h: 7,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("GeckoTerminalMarketDataProvider", () => {
  const provider = new GeckoTerminalMarketDataProvider();

  beforeEach(() => {
    vi.clearAllMocks();
    loadTestConfig();
    api.tokenMetrics.mockResolvedValue({ tokens: [], pools: [] });
    api.searchPools.mockResolvedValue([]);
    api.newPools.mockResolvedValue([]);
  });

  it("answers only for chains the API covers", () => {
    expect(provider.supportsChain("base:mainnet")).toBe(true);
    expect(provider.supportsChain("arc:testnet")).toBe(false);
  });

  /** The interface's contract, and the one every caller keys on. */
  it("keys results by lowercased contract id", async () => {
    api.tokenMetrics.mockResolvedValue({ tokens: [token({ address: "0xABC".toLowerCase() })], pools: [] });

    const result = await provider.getMarketData("base:mainnet", ["0xABC"]);

    expect([...result.keys()]).toEqual(["0xabc"]);
  });

  it("takes the change columns from the token's deepest pool", async () => {
    api.tokenMetrics.mockResolvedValue({
      tokens: [token()],
      pools: [
        pool({ address: "0xdust", reserveUsd: 10, priceChange24h: 900 }),
        pool({ address: "0xdeep", reserveUsd: 500_000, priceChange24h: 4 }),
      ],
    });

    const row = (await provider.getMarketData("base:mainnet", ["0xabc"])).get("0xabc")!;

    // Averaging a deep pool with a dust pool quotes a price nobody can trade at.
    expect(row.priceChange24h).toBe(4);
    expect(row.txnsBuys24h).toBe(12);
  });

  it("leaves pool-sourced columns null when no pool came back", async () => {
    api.tokenMetrics.mockResolvedValue({ tokens: [token()], pools: [] });

    const row = (await provider.getMarketData("base:mainnet", ["0xabc"])).get("0xabc")!;

    expect(row.priceChange5m).toBeNull();
    expect(row.txnsBuys24h).toBeNull();
    expect(row.pairCreatedAt).toBeNull();
    // The token's own metrics survive: a missing pool is not a missing token.
    expect(row.priceUsd).toBe(2500);
  });

  it("returns nothing for an unsupported chain without calling the API", async () => {
    expect(await provider.getMarketData("arc:testnet", ["0xabc"])).toEqual(new Map());
    expect(api.tokenMetrics).not.toHaveBeenCalled();
  });

  /**
   * An unscoped search returns pools from every network at once. Attributing
   * one to the chain the caller happened to be looking at is how USDC on Base
   * ends up rendered as USDC on Solana.
   */
  it("drops search hits from networks this build does not describe", async () => {
    api.searchPools.mockResolvedValue([
      pool({ network: "base", baseTokenAddress: "0xabc" }),
      pool({ network: "some-unlisted-chain", baseTokenAddress: "0xdef" }),
      pool({ network: null, baseTokenAddress: "0xghi" }),
    ]);

    const results = await provider.search("weth");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ chainId: "base:mainnet", contractId: "0xabc" });
  });

  it("keeps the deepest pool when a search returns several for one token", async () => {
    api.searchPools.mockResolvedValue([
      pool({ reserveUsd: 10, priceUsd: 1 }),
      pool({ reserveUsd: 900_000, priceUsd: 2500 }),
    ]);

    const results = await provider.search("weth", "base:mainnet");

    expect(results).toHaveLength(1);
    expect(results[0]!.priceUsd).toBe(2500);
  });
});
