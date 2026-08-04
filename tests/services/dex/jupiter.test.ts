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

  it("converts Jupiter's fractional price impact to a percentage", async () => {
    const provider = new JupiterProvider(SOLANA_MAINNET);
    fetchMock.mockResolvedValue(quoteResponse("74000000"));

    const quote = await provider.getQuote("SOL", "USDC", 1);

    // 0.001 as reported is 0.1%, and DEXQuote's contract is a percentage.
    expect(quote.priceImpact).toBe(0.1);
    expect(quote.amountOut).toBeCloseTo(74, 6);
  });
});
