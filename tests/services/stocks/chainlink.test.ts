import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { ConfigManager } from "../../../src/config.js";

const mockPublicClient = { readContract: vi.fn() };

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, createPublicClient: vi.fn(() => mockPublicClient) };
});

// Only base:mainnet is registered, so an unknown chain exercises the null path.
vi.mock("../../../src/services/chains/chainAdapterRegistry.js", () => ({
  ChainAdapterRegistry: {
    getInstance: () => ({
      has: (chainId: string) => chainId === "base:mainnet",
      get: () => ({
        descriptor: {
          chainId: "base:mainnet",
          family: "evm",
          evm: { id: 8453, defaultRpcUrl: "https://mainnet.base.org" },
        },
      }),
    }),
  },
}));

const FEED = "0x04689a41629776563E6822F76f2e57D148d28513";
const NOW_MS = 1_800_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

describe("EquityPriceOracle", () => {
  let EquityPriceOracle: typeof import("../../../src/services/stocks/chainlink.js").EquityPriceOracle;

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.load();
    ({ EquityPriceOracle } = await import("../../../src/services/stocks/chainlink.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function oracle() {
    // No cache TTL so each call hits the mocked client.
    return new EquityPriceOracle(0, 3600);
  }

  it("scales the feed answer by its decimals and reports freshness", async () => {
    mockPublicClient.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "decimals") return 8;
      return [1n, 21178500000n, 0n, BigInt(NOW_SEC), 1n];
    });

    const price = await oracle().price("base:mainnet", FEED, NOW_MS);
    expect(price).not.toBeNull();
    expect(price!.priceUsd).toBeCloseTo(211.785, 6);
    expect(price!.stale).toBe(false);
  });

  it("treats a zero answer as no price, not as $0", async () => {
    // Chainlink warns tokenized-equity feeds can report zero in thin overnight
    // sessions with a fresh timestamp. Valuing a position at nothing is worse
    // than saying "unknown".
    mockPublicClient.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "decimals") return 8;
      return [9n, 0n, 0n, BigInt(NOW_SEC), 9n];
    });

    await expect(oracle().price("base:mainnet", FEED, NOW_MS)).resolves.toBeNull();
  });

  it("returns a stale price flagged, rather than hiding a weekend close", async () => {
    // Equities hold their last close off-hours; old is the normal state, but
    // callers that must not settle on a frozen price need to know.
    mockPublicClient.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "decimals") return 8;
      return [1n, 10000000000n, 0n, BigInt(NOW_SEC - 7200), 1n];
    });

    const price = await oracle().price("base:mainnet", FEED, NOW_MS);
    expect(price?.priceUsd).toBe(100);
    expect(price?.stale).toBe(true);
  });

  it("returns null for a chain this deployment does not run", async () => {
    await expect(oracle().price("celo:mainnet", FEED, NOW_MS)).resolves.toBeNull();
  });

  it("returns null when the feed read reverts", async () => {
    mockPublicClient.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "decimals") return 8;
      throw new Error("execution reverted");
    });
    await expect(oracle().price("base:mainnet", FEED, NOW_MS)).resolves.toBeNull();
  });
});
