import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConfigManager } from "../../../src/config.js";

/**
 * Jupiter routing for Solana.
 *
 * The descriptor pointed at `quote-api.jup.ag/v6` — a host that no longer
 * resolves — so `solana:mainnet` registered, listed its tokens, and then
 * answered "no route" for every pair. Nothing failed loudly: a chain with a
 * dead quote endpoint is indistinguishable from a chain with no liquidity,
 * which is exactly why it survived a conformance suite and a green test run.
 *
 * These tests pin the parts that can be checked without the network. The part
 * that cannot — that the endpoint is *live* — is covered by the reachability
 * check in the integration suite.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { JupiterProvider } = await import("../../../src/services/dex/providers/jupiter.js");
const { SOLANA_MAINNET } = await import("../../../src/services/chains/descriptors/solana.js");

function loadConfig(jupiterKey?: string) {
  process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
  process.env.AES_KEY = "testkey";
  process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
  if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
  if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
  if (jupiterKey) process.env.JUPITER_API_KEY = jupiterKey;
  else delete process.env.JUPITER_API_KEY;
  ConfigManager.reset();
  ConfigManager.load();
}

function quoteResponse(outAmount: string) {
  return {
    ok: true,
    json: async () => ({
      outAmount,
      priceImpactPct: "0.001",
      routePlan: [{ swapInfo: { feeAmount: "1000" } }],
    }),
  };
}

describe("JupiterProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfig();
  });

  it("targets a host that still exists", () => {
    // The regression itself. `quote-api.jup.ag` is gone; anything still
    // pointing at it produces a chain that quotes nothing.
    expect(SOLANA_MAINNET.svm!.jupiterApiUrl).not.toContain("quote-api.jup.ag");
    expect(SOLANA_MAINNET.svm!.jupiterApiUrl).toMatch(/^https:\/\/(lite-api|api)\.jup\.ag\//);
  });

  it("uses the free host and sends no key when none is configured", async () => {
    const provider = new JupiterProvider(SOLANA_MAINNET);
    fetchMock.mockResolvedValue(quoteResponse("74000000"));

    await provider.getQuote("SOL", "USDC", 1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("lite-api.jup.ag");
    expect((init as RequestInit | undefined)?.headers ?? {}).not.toHaveProperty("x-api-key");
  });

  it("switches to the keyed host when a key is configured", async () => {
    // Same API surface, different host and an auth header — so a key changes
    // where requests go, not how they are built.
    loadConfig("jup_test_key");
    const provider = new JupiterProvider(SOLANA_MAINNET);
    fetchMock.mockResolvedValue(quoteResponse("74000000"));

    await provider.getQuote("SOL", "USDC", 1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("//api.jup.ag");
    expect(String(url)).not.toContain("lite-api");
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "jup_test_key" });
  });

  it("reports no route rather than throwing when the endpoint is unreachable", async () => {
    // How the outage actually presented. Worth pinning: the failure must stay
    // survivable, but it must not be the *only* signal.
    const provider = new JupiterProvider(SOLANA_MAINNET);
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND quote-api.jup.ag"));

    expect(await provider.hasRoute("SOL", "USDC")).toBe(false);
    expect((await provider.getQuote("SOL", "USDC", 1)).amountOut).toBe(0);
  });

  /**
   * An unknown mint's decimals used to default to the descriptor's native 9,
   * with a comment saying so and adding that "its amounts should not be
   * trusted for sizing". They were used for sizing: `resolveToken` feeds
   * `toRaw(amount, decimals)` in `buildSwapPayload`, which is the number of
   * base units actually spent.
   *
   * This is the same bug the EVM path fixed by reading `decimals()` on-chain —
   * "treating a 6-decimal token as 18-decimal turns 'swap 1 token' into a
   * request to spend 10^12 times more". Discovery surfaces arbitrary mints
   * with a Trade button, so unknown mints are the normal case, not the edge.
   */
  describe("decimals for an unknown mint", () => {
    // A real base58 mint that is not in the curated list.
    const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";

    const mintAccount = (decimals: number) => ({
      ok: true,
      json: async () => ({
        result: { value: { data: { parsed: { info: { decimals } } } } },
      }),
    });

    it("reads them from the SPL mint account instead of assuming 9", async () => {
      const provider = new JupiterProvider(SOLANA_MAINNET);
      fetchMock.mockImplementation(async (url: string) =>
        String(url).includes("jup.ag") ? quoteResponse("1000000") : mintAccount(6)
      );

      await provider.getQuote(MINT, "USDC", 1);

      const quoteUrl = fetchMock.mock.calls.map(String).find((u) => u.includes("jup.ag"))!;
      // 1 token at 6 decimals is 1_000_000 base units. At the old default of 9
      // it would have asked to move 1_000_000_000 — a thousand times more.
      // Anchored: "amount=1000000000" contains "amount=1000000" as a
      // substring, so a `toContain` here passes against the very bug it is
      // meant to catch.
      expect(quoteUrl).toMatch(/[?&]amount=1000000(&|$)/);
    });

    it("caches the lookup, since an SPL mint's decimals cannot change", async () => {
      const provider = new JupiterProvider(SOLANA_MAINNET);
      fetchMock.mockImplementation(async (url: string) =>
        String(url).includes("jup.ag") ? quoteResponse("1000000") : mintAccount(6)
      );

      await provider.getQuote(MINT, "USDC", 1);
      await provider.getQuote(MINT, "USDC", 1);

      const rpcCalls = fetchMock.mock.calls.filter((c) => !String(c[0]).includes("jup.ag"));
      expect(rpcCalls).toHaveLength(1);
    });

    it("refuses to resolve a mint whose decimals cannot be read", async () => {
      const provider = new JupiterProvider(SOLANA_MAINNET);
      fetchMock.mockImplementation(async (url: string) =>
        String(url).includes("jup.ag")
          ? quoteResponse("1000000")
          : { ok: true, json: async () => ({ result: { value: null } }) }
      );

      // "No route" is a cheap, visible failure. A wrong scale factor is not.
      expect(await provider.hasRoute(MINT, "USDC")).toBe(false);
      expect((await provider.getQuote(MINT, "USDC", 1)).amountOut).toBe(0);
    });

    it("still resolves curated symbols without an RPC round trip", async () => {
      const provider = new JupiterProvider(SOLANA_MAINNET);
      fetchMock.mockResolvedValue(quoteResponse("74000000"));

      await provider.getQuote("SOL", "USDC", 1);

      expect(fetchMock.mock.calls.every((c) => String(c[0]).includes("jup.ag"))).toBe(true);
    });
  });

  it("converts Jupiter's fractional price impact to a percentage", async () => {
    const provider = new JupiterProvider(SOLANA_MAINNET);
    fetchMock.mockResolvedValue(quoteResponse("74000000"));

    const quote = await provider.getQuote("SOL", "USDC", 1);

    // 0.001 as reported is 0.1%, and DEXQuote's contract is a percentage.
    expect(quote.priceImpact).toBe(0.1);
    expect(quote.amountOut).toBeCloseTo(74, 6);
  });

  describe("curated tokenized stocks (Ondo)", () => {
    const NVDAON_MINT = "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo";

    it("lists them so discovery treats them as routable", async () => {
      const provider = new JupiterProvider(SOLANA_MAINNET);
      const tokens = await provider.getSwappableTokens();
      const nvda = tokens.find((t) => t.symbol === "NVDAon");
      expect(nvda).toBeDefined();
      expect(nvda!.contractId).toBe(NVDAON_MINT);
      expect(nvda!.decimals).toBe(9);
    });

    it("resolves a stock by symbol without an RPC round trip", async () => {
      const provider = new JupiterProvider(SOLANA_MAINNET);
      fetchMock.mockResolvedValue(quoteResponse("199580000")); // 199.58 USDC (6dp)

      const quote = await provider.getQuote("NVDAon", "USDC", 1);

      // 1 NVDAon at 9 decimals = 1_000_000_000 base units.
      const quoteUrl = fetchMock.mock.calls.map(String).find((u) => u.includes("jup.ag"))!;
      expect(quoteUrl).toMatch(/[?&]amount=1000000000(&|$)/);
      expect(quote.amountOut).toBeCloseTo(199.58, 6);
      expect(fetchMock.mock.calls.every((c) => String(c[0]).includes("jup.ag"))).toBe(true);
    });

    it("resolves a stock by its exact, case-sensitive mint", async () => {
      const provider = new JupiterProvider(SOLANA_MAINNET);
      fetchMock.mockResolvedValue(quoteResponse("199580000"));

      expect(await provider.hasRoute(NVDAON_MINT, "USDC")).toBe(true);
      // Curated, so decimals are known: no RPC lookup.
      expect(fetchMock.mock.calls.every((c) => String(c[0]).includes("jup.ag"))).toBe(true);
    });
  });
});
