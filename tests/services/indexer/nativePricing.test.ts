import { describe, it, expect, beforeEach, vi } from "vitest";

const mockToken = { findMany: vi.fn() };
vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => ({ prisma: { token: mockToken } }) },
}));

const mockDexRegistry = { getTokenPrice: vi.fn() };
vi.mock("../../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: { getInstance: () => mockDexRegistry },
}));

const { resolveNativeUsd } = await import("../../../src/services/indexer/nativePricing.js");

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const STABLE = "0x05fb7316d600edc32c184e6987563fad153fcba3";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const descriptor = { chainId: "robinhood:mainnet", nativeSymbol: "ETH" } as any;

function input(anchorPools: unknown[] = []) {
  return {
    descriptor,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    anchorPools: anchorPools as any,
    wrappedNative: WETH,
    stables: new Set([STABLE]),
  };
}

describe("resolveNativeUsd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToken.findMany.mockResolvedValue([]);
    mockDexRegistry.getTokenPrice.mockResolvedValue(0);
  });

  it("prefers the deepest local native/stable pool", async () => {
    const price = await resolveNativeUsd(
      input([
        { token0: WETH, lastPrice0: 2500, liquidityUsd: 1_000 },
        { token0: WETH, lastPrice0: 3000, liquidityUsd: 900_000 },
      ])
    );

    expect(price).toBe(3000);
    // A local pool answers outright; no cross-chain lookup should happen.
    expect(mockToken.findMany).not.toHaveBeenCalled();
  });

  it("inverts when the native asset is token1", async () => {
    const price = await resolveNativeUsd(
      input([{ token0: STABLE, lastPrice0: 0.0004, liquidityUsd: 100 }])
    );

    expect(price).toBeCloseTo(2500, 6);
  });

  it("falls back to the same asset priced on another chain", async () => {
    // Robinhood has no WETH/rUSDC pool at any fee tier — this path is the only
    // reason that chain's swaps can be valued at all.
    mockToken.findMany.mockResolvedValue([
      { symbol: "WETH", priceUsd: 3123.45, liquidityUsd: 50_000_000 },
    ]);

    const price = await resolveNativeUsd(input([]));

    expect(price).toBe(3123.45);
    const where = mockToken.findMany.mock.calls[0]![0].where;
    // Must not price a mainnet from a testnet, or from itself.
    expect(where.chainId).toEqual({ not: "robinhood:mainnet" });
    expect(where.priceUsd).toEqual({ gt: 0 });
  });

  it("matches ETH and WETH as the same asset", async () => {
    mockToken.findMany.mockResolvedValue([]);
    await resolveNativeUsd(input([]));

    const symbols = mockToken.findMany.mock.calls[0]![0].where.symbol.in;
    expect(symbols).toEqual(expect.arrayContaining(["ETH", "WETH"]));
  });

  it("falls back to a live DEX quote last", async () => {
    mockDexRegistry.getTokenPrice.mockResolvedValue(2999);

    const price = await resolveNativeUsd(input([]));

    expect(price).toBe(2999);
  });

  it("returns null rather than guessing when nothing can price the asset", async () => {
    // A wrong anchor misprices every token on the chain by the same factor and
    // is far harder to notice than a missing one.
    const price = await resolveNativeUsd(input([]));
    expect(price).toBeNull();
  });

  it("ignores anchor pools with no usable price", async () => {
    const price = await resolveNativeUsd(
      input([
        { token0: WETH, lastPrice0: null, liquidityUsd: 10_000_000 },
        { token0: WETH, lastPrice0: 0, liquidityUsd: 9_000_000 },
        { token0: WETH, lastPrice0: 3000, liquidityUsd: 1 },
      ])
    );

    expect(price).toBe(3000);
  });
});
