import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { ConfigManager } from "../../../src/config.js";
import { CircuitBreakerRegistry } from "../../../src/utils/circuitBreaker.js";

const mockPublicClient = {
  simulateContract: vi.fn(),
  readContract: vi.fn(),
};

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, createPublicClient: vi.fn(() => mockPublicClient) };
});

/**
 * Aerodrome Slipstream on Base, exercised against the real descriptor.
 *
 * The specifics that matter and are easy to get wrong: a router is bound to the
 * factory it was built with (so there is one per factory, not one per chain),
 * and the QuoterV2 struct orders `amountIn` before `tickSpacing` — unlike
 * Uniswap V3's fee-before-amountIn struct.
 */
describe("AerodromeProvider", () => {
  let AerodromeProvider: typeof import("../../../src/services/dex/providers/aerodrome.js").AerodromeProvider;
  let provider: import("../../../src/services/dex/providers/aerodrome.js").AerodromeProvider;
  let BASE_MAINNET: import("../../../src/types/chain.js").ChainDescriptor;

  const WETH = "0x4200000000000000000000000000000000000006";
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const NVDAc = "0xb20000000000000000000078ee7ce2fe4908108c";
  const SENDER = "0x1111111111111111111111111111111111111111";

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.load();
    ({ BASE_MAINNET } = await import("../../../src/services/chains/descriptors/base.js"));
    ({ AerodromeProvider } = await import("../../../src/services/dex/providers/aerodrome.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // The all-tiers-revert case trips the shared breaker for `Aerodrome-…`,
    // and a provider name is per-chain, so without this every later test would
    // be short-circuited by a breaker the previous one opened.
    CircuitBreakerRegistry.clear();
    provider = new AerodromeProvider(BASE_MAINNET);
  });

  it("describes every Slipstream factory with its own router and quoter", () => {
    const slip = BASE_MAINNET.evm!.aerodrome!.slipstream!;
    expect(slip).toHaveLength(3);
    const routers = new Set(slip.map((d) => d.router.toLowerCase()));
    expect(routers.size).toBe(3);
    // The deepest stock pools are on this factory at tick spacing 10; if this
    // drops out, the route the integration exists for disappears.
    const newest = slip.find((d) => d.factory.toLowerCase() === "0xf8f2eb4940cfe7d13603dddd87f123820fc061ef");
    expect(newest?.tickSpacings).toContain(10);
  });

  it("lists the curated stock tokens alongside the chain's base assets", async () => {
    const symbols = (await provider.getSwappableTokens()).map((t) => t.symbol);
    expect(symbols).toEqual(expect.arrayContaining(["WETH", "USDC", "DAI", "NVDAc", "AAPLc", "TSLAc"]));
  });

  it("hasRoute is true when any tick spacing has a pool", async () => {
    mockPublicClient.simulateContract.mockResolvedValue({ result: [1000000n, 0n, 0, 0n] });
    await expect(provider.hasRoute(NVDAc, USDC)).resolves.toBe(true);
  });

  it("hasRoute is false when every factory and tick spacing reverts", async () => {
    mockPublicClient.simulateContract.mockRejectedValue(new Error("execution reverted"));
    await expect(provider.hasRoute(NVDAc, USDC)).resolves.toBe(false);
  });

  it("buildSwapPayload approves the router the quote answered from, then swaps", async () => {
    mockPublicClient.simulateContract.mockResolvedValue({ result: [213349703n, 0n, 1, 0n] });
    mockPublicClient.readContract.mockResolvedValue(0n); // no allowance

    const payload = await provider.buildSwapPayload(NVDAc, USDC, 1, 200, SENDER);

    expect(payload).not.toBeNull();
    expect(payload!.kind).toBe("evm");
    expect(payload!.calls).toHaveLength(2); // approve + swap
    // Approve targets the token; swap targets a configured Slipstream router.
    expect(payload!.calls![0]!.to.toLowerCase()).toBe(NVDAc);
    const routers = BASE_MAINNET.evm!.aerodrome!.slipstream!.map((d) => d.router.toLowerCase());
    expect(routers).toContain(payload!.calls![1]!.to.toLowerCase());
  });

  it("wraps the native asset before swapping it", async () => {
    mockPublicClient.simulateContract.mockResolvedValue({ result: [1000000n, 0n, 0, 0n] });
    mockPublicClient.readContract.mockResolvedValue(0n);

    const payload = await provider.buildSwapPayload("ETH", USDC, 1, 0.9, SENDER);

    expect(payload).not.toBeNull();
    // deposit (value) + approve + swap
    expect(payload!.calls).toHaveLength(3);
    expect(payload!.calls![0]!.to.toLowerCase()).toBe(WETH);
    expect(payload!.calls![0]!.value).toBeDefined();
    expect(payload!.calls![2]!.value).toBe("0");
  });

  it("omits the approve when the allowance already covers the swap", async () => {
    mockPublicClient.simulateContract.mockResolvedValue({ result: [1000000n, 0n, 0, 0n] });
    mockPublicClient.readContract.mockResolvedValue(10n ** 30n);

    const payload = await provider.buildSwapPayload(NVDAc, USDC, 1, 0.9, SENDER);
    expect(payload!.calls).toHaveLength(1); // swap only
  });
});
