import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { ConfigManager } from "../../../src/config.js";

const mockPublicClient = {
  simulateContract: vi.fn(),
  readContract: vi.fn(),
};

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => mockPublicClient),
  };
});

/**
 * UniswapV3Provider, exercised against Base's descriptor.
 *
 * These ran against a `UniswapV3BaseProvider` subclass until that class was
 * deleted: it added a BASE_NETWORK-driven singleton and no behaviour, and
 * nothing outside its own test imported it. Every V3 fork is
 * `new UniswapV3Provider(descriptor)` now, so the tests point at that.
 */
describe("UniswapV3Provider", () => {
  let UniswapV3Provider: typeof import("../../../src/services/dex/providers/uniswapV3.js").UniswapV3Provider;
  let provider: import("../../../src/services/dex/providers/uniswapV3.js").UniswapV3Provider;

  const WETH = "0x4200000000000000000000000000000000000006";
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const SENDER = "0x1111111111111111111111111111111111111111";

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.load();
    ({ UniswapV3Provider } = await import("../../../src/services/dex/providers/uniswapV3.js"));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const { BASE_MAINNET } = await import("../../../src/services/chains/descriptors/base.js");
    provider = new UniswapV3Provider(BASE_MAINNET);
  });

  it("only ships addresses viem will accept as contract targets", async () => {
    // Regression: MAINNET_QUOTER was one hex char short. viem threw inside
    // quoteRaw's per-fee-tier catch, so every mainnet pair silently reported
    // "no route" with nothing logged. Descriptor addresses are validated at
    // adapter registration now — see assertValidAddresses.
    const { isAddress } = await import("viem");
    const tokens = await provider.getSwappableTokens();
    for (const t of tokens) {
      expect(isAddress(t.contractId, { strict: false }), `${t.symbol} ${t.contractId}`).toBe(true);
    }

    // Reaching the quoter/router at all proves those constants are valid too:
    // an invalid one throws before any RPC call is attempted.
    mockPublicClient.simulateContract.mockResolvedValue({
      result: [1000000n, 0n, 0, 0n],
    });
    await expect(provider.hasRoute("WETH", "USDC")).resolves.toBe(true);
    expect(mockPublicClient.simulateContract).toHaveBeenCalled();
  });

  it("returns the curated token list", async () => {
    const tokens = await provider.getSwappableTokens();
    expect(tokens.map((t) => t.symbol)).toEqual(expect.arrayContaining(["WETH", "USDC", "DAI"]));
  });

  it("getQuote succeeds on the first fee tier that has a pool", async () => {
    mockPublicClient.simulateContract.mockResolvedValueOnce({
      result: [2000000000000000000n, 0n, 0, 0n], // 2 WETH -> ... just needs amountOut > 0
    });
    // getTokenPrice calls for priceImpact (WETH->USDC and USDC->USDC-is-1 short-circuit)
    mockPublicClient.simulateContract.mockResolvedValueOnce({
      result: [3000000000n, 0n, 0, 0n], // priceIn probe
    });

    const quote = await provider.getQuote("WETH", "USDC", 1);
    expect(quote.amountOut).toBeGreaterThan(0);
    expect(quote.feeBps).toBe(5); // 500 (first tier) / 100
  });

  it("hasRoute returns false when every fee tier reverts (no pool)", async () => {
    mockPublicClient.simulateContract.mockRejectedValue(new Error("execution reverted"));
    const has = await provider.hasRoute(WETH, USDC);
    expect(has).toBe(false);
    expect(mockPublicClient.simulateContract).toHaveBeenCalledTimes(3); // tried all 3 fee tiers
  });

  it("hasRoute returns true as soon as one fee tier has liquidity", async () => {
    mockPublicClient.simulateContract
      .mockRejectedValueOnce(new Error("no pool at 500"))
      .mockResolvedValueOnce({ result: [1000000n, 0n, 0, 0n] }); // 3000 tier succeeds

    const has = await provider.hasRoute(WETH, USDC);
    expect(has).toBe(true);
  });

  it("buildSwapPayload includes an approve call when allowance is insufficient", async () => {
    mockPublicClient.simulateContract.mockResolvedValue({ result: [1000000n, 0n, 0, 0n] });
    mockPublicClient.readContract.mockResolvedValue(0n); // no existing allowance

    const payload = await provider.buildSwapPayload(WETH, USDC, 1, 0.9, SENDER);
    expect(payload).not.toBeNull();
    expect(payload!.kind).toBe("evm");
    expect(payload!.calls).toHaveLength(2); // approve + swap
    expect(payload!.calls![0]!.to.toLowerCase()).toBe(WETH.toLowerCase());
  });

  it("buildSwapPayload omits the approve call when allowance is already sufficient", async () => {
    mockPublicClient.simulateContract.mockResolvedValue({ result: [1000000n, 0n, 0, 0n] });
    mockPublicClient.readContract.mockResolvedValue(10n ** 30n); // effectively unlimited allowance

    const payload = await provider.buildSwapPayload(WETH, USDC, 1, 0.9, SENDER);
    expect(payload).not.toBeNull();
    expect(payload!.calls).toHaveLength(1); // swap only
  });

  // ─── Uncatalogued tokens ───────────────────────────────────────────────────
  // Token discovery surfaces the long tail the descriptor never listed, each
  // with a Trade button, so an address that isn't in the curated token list is
  // now the common path rather than an edge case.

  it("reads decimals from the contract for a token outside the curated list", async () => {
    const MEME = "0x5aD1Bd30914cF62668Aaba0606490D17723aF962";

    // decimals() -> 6. Assuming 18 here would build parseUnits("1", 18): a
    // request to spend 10^12 times what the user asked for.
    mockPublicClient.readContract.mockResolvedValue(6);
    mockPublicClient.simulateContract.mockResolvedValue({ result: [1000000n, 0n, 0, 0n] });

    const ok = await provider.hasRoute(MEME, USDC);

    expect(ok).toBe(true);
    expect(mockPublicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "decimals" })
    );
  });

  it("caches decimals so a repeated quote does not re-read the contract", async () => {
    // An ERC-20's decimals cannot change, so re-reading them is a round trip
    // per quote for an answer that is already known.
    const MEME = "0x2222222222222222222222222222222222222223";
    mockPublicClient.readContract.mockResolvedValue(6);
    mockPublicClient.simulateContract.mockResolvedValue({ result: [1000000n, 0n, 0, 0n] });

    await provider.hasRoute(MEME, USDC);
    const afterFirst = mockPublicClient.readContract.mock.calls.filter(
      (c: unknown[]) => (c[0] as { functionName: string }).functionName === "decimals"
    ).length;

    await provider.hasRoute(MEME, USDC);
    const afterSecond = mockPublicClient.readContract.mock.calls.filter(
      (c: unknown[]) => (c[0] as { functionName: string }).functionName === "decimals"
    ).length;

    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1);
  });

  it("refuses to resolve a token whose decimals cannot be read", async () => {
    const BROKEN = "0x1111111111111111111111111111111111111112";
    mockPublicClient.readContract.mockRejectedValue(new Error("no such method"));
    mockPublicClient.simulateContract.mockResolvedValue({ result: [1000000n, 0n, 0, 0n] });

    // Failing closed costs a "no route". Guessing costs funds, because
    // decimals scales the amount actually spent.
    const payload = await provider.buildSwapPayload(BROKEN, USDC, 1, 0.9, SENDER);
    expect(payload).toBeNull();
  });

  it("buildSwapPayload returns null when no pool exists on any fee tier", async () => {
    mockPublicClient.simulateContract.mockRejectedValue(new Error("execution reverted"));
    const payload = await provider.buildSwapPayload(WETH, USDC, 1, 0.9, SENDER);
    expect(payload).toBeNull();
  });
});
