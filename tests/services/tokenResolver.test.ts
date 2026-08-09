import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Turning what a user typed into something tradable.
 *
 * Both interfaces used to compare a typed string against the DEX providers'
 * curated list with an exact match, which rejected two things it shouldn't
 * have: contract addresses (an address never equals a symbol) and every token
 * the indexer had discovered — the whole long tail it exists to surface. The
 * feature built to find those tokens could not be used to buy them.
 */

const swappable: Record<string, { contractId: string; symbol: string; name: string; decimals: number }[]> = {};
vi.mock("../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: {
    getInstance: () => ({
      getSwappableTokens: vi.fn(async (_refresh: boolean, chainId: string) => swappable[chainId] ?? []),
    }),
  },
}));

const registered: { chainId: string; family: string; isTestnet: boolean }[] = [];
vi.mock("../../src/services/chains/chainAdapterRegistry.js", () => ({
  ChainAdapterRegistry: {
    getInstance: () => ({
      list: () => registered,
      find: (chainId: string) => registered.find((c) => c.chainId === chainId),
    }),
  },
}));

const tokenRows: Record<string, unknown>[] = [];
const indexedRows: Record<string, unknown>[] = [];

vi.mock("../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({
      prisma: {
        token: { findMany: vi.fn(async () => tokenRows) },
        indexedToken: { findMany: vi.fn(async () => indexedRows) },
      },
    }),
  },
}));

const { resolveTokenQuery, pickUnambiguous, looksLikeAddress } = await import(
  "../../src/services/tokenResolver.js"
);

const BASE = "base:mainnet";
const CELO = "celo:mainnet";
const WETH = "0x4200000000000000000000000000000000000006";

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(swappable)) delete swappable[key];
  registered.length = 0;
  tokenRows.length = 0;
  indexedRows.length = 0;

  registered.push(
    { chainId: BASE, family: "evm", isTestnet: false },
    { chainId: CELO, family: "evm", isTestnet: false },
    { chainId: "base:sepolia", family: "evm", isTestnet: true }
  );
});

describe("looksLikeAddress", () => {
  it("recognises each family's own shape", () => {
    expect(looksLikeAddress(WETH, BASE)).toBe(true);
    expect(looksLikeAddress("WELSH", BASE)).toBe(false);
    // Distinguishing "pasted an address" from "typed an unknown symbol" is the
    // point: they deserve different answers.
    expect(looksLikeAddress("0xnot-hex", BASE)).toBe(false);
  });

  it("says no for a chain that isn't enabled", () => {
    expect(looksLikeAddress(WETH, "arbitrum:mainnet")).toBe(false);
  });
});

describe("resolveTokenQuery", () => {
  it("finds a curated token by symbol", async () => {
    swappable[BASE] = [{ contractId: WETH, symbol: "WETH", name: "Wrapped Ether", decimals: 18 }];

    const [match] = await resolveTokenQuery("weth", BASE);
    expect(match!.source).toBe("provider");
    expect(match!.contractId).toBe(WETH);
  });

  it("finds a curated token by contract address", async () => {
    // The case the old exact-symbol check could never satisfy.
    swappable[BASE] = [{ contractId: WETH, symbol: "WETH", name: "Wrapped Ether", decimals: 18 }];

    const [match] = await resolveTokenQuery(WETH, BASE);
    expect(match!.symbol).toBe("WETH");
  });

  it("finds a token the indexer discovered but no provider lists", async () => {
    // The long tail. Previously unreachable from either interface.
    indexedRows.push({
      chainId: BASE,
      contractId: "0x1111111111111111111111111111111111111111",
      symbol: "TAIL",
      name: "Long Tail",
      decimals: 18,
      liquidityUsd: 5000,
      priceUsd: 0.4,
    });

    const [match] = await resolveTokenQuery("TAIL", BASE);
    expect(match!.source).toBe("indexed");
    expect(match!.liquidityUsd).toBe(5000);
  });

  it("enriches a provider hit with catalogue signals rather than duplicating it", async () => {
    swappable[BASE] = [{ contractId: WETH, symbol: "WETH", name: "Wrapped Ether", decimals: 18 }];
    tokenRows.push({
      chainId: BASE,
      contractId: WETH,
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
      liquidityUsd: 9_000_000,
      priceUsd: 3000,
      isVerified: true,
    });

    const matches = await resolveTokenQuery("WETH", BASE);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.source).toBe("provider");
    expect(matches[0]!.priceUsd).toBe(3000);
    expect(matches[0]!.isVerified).toBe(true);
  });

  it("accepts an unknown address on a known chain, marked as unknown", async () => {
    const match = (await resolveTokenQuery("0x9999999999999999999999999999999999999999", BASE))[0]!;

    expect(match.source).toBe("address");
    // Decimals are deliberately not guessed — they scale the amount actually
    // spent, and the provider reads them from the contract at quote time.
    expect(match.decimals).toBe(0);
    expect(match.isVerified).toBe(false);
  });

  it("refuses a bare address with no chain to place it on", async () => {
    // Resolving one against every chain would invite trading the wrong one.
    expect(await resolveTokenQuery("0x9999999999999999999999999999999999999999")).toEqual([]);
  });

  it("does not offer an unknown symbol as if it were an address", async () => {
    expect(await resolveTokenQuery("NOTATOKEN", BASE)).toEqual([]);
  });

  it("ranks curated above discovered, and deeper liquidity first", async () => {
    swappable[BASE] = [{ contractId: WETH, symbol: "USDC", name: "USD Coin", decimals: 6 }];
    indexedRows.push(
      { chainId: BASE, contractId: "0xaaa", symbol: "USDC", name: "thin", decimals: 6, liquidityUsd: 10, priceUsd: 1 },
      { chainId: BASE, contractId: "0xbbb", symbol: "USDC", name: "deep", decimals: 6, liquidityUsd: 900, priceUsd: 1 }
    );

    const matches = await resolveTokenQuery("USDC", BASE);
    expect(matches.map((m) => m.source)).toEqual(["provider", "indexed", "indexed"]);
    expect(matches[1]!.contractId).toBe("0xbbb");
  });

  it("searches only mainnets when no chain is given", async () => {
    // A testnet price is arbitrary; offering one next to a real token invites
    // trading it by accident.
    swappable["base:sepolia"] = [
      { contractId: "0xtest", symbol: "WELSH", name: "Testnet", decimals: 18 },
    ];

    expect(await resolveTokenQuery("WELSH")).toEqual([]);
  });
});

describe("pickUnambiguous", () => {
  it("returns nothing when a symbol spans chains", async () => {
    // USDC is on five. Choosing silently is how someone buys the right ticker
    // on the wrong network.
    swappable[BASE] = [{ contractId: "0xbase", symbol: "USDC", name: "USD Coin", decimals: 6 }];
    swappable[CELO] = [{ contractId: "0xcelo", symbol: "USDC", name: "USD Coin", decimals: 6 }];

    const matches = await resolveTokenQuery("USDC");
    expect(matches.length).toBe(2);
    expect(pickUnambiguous(matches)).toBeNull();
  });

  it("picks the best candidate when they're all on one chain", async () => {
    // The caller already said which network, so ranking is enough.
    swappable[BASE] = [{ contractId: "0xbase", symbol: "USDC", name: "USD Coin", decimals: 6 }];
    indexedRows.push({
      chainId: BASE,
      contractId: "0xfake",
      symbol: "USDC",
      name: "Fake",
      decimals: 6,
      liquidityUsd: 1,
      priceUsd: 1,
    });

    const chosen = pickUnambiguous(await resolveTokenQuery("USDC", BASE));
    expect(chosen!.source).toBe("provider");
  });

  it("handles the empty case", () => {
    expect(pickUnambiguous([])).toBeNull();
  });
});
