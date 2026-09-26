import { describe, it, expect, beforeAll, vi } from "vitest";
import { ConfigManager } from "../../../src/config.js";
import { ARC_MAINNET } from "../../../src/services/chains/descriptors/arc.js";

/**
 * Arc's native asset is an ERC-20, not a wrappable one.
 *
 * Every other EVM chain here routes its native asset through a wrapper:
 * resolve the symbol to `wrappedNative` at the descriptor's decimals, bracket
 * the swap with deposit/withdraw. Arc breaks both halves of that. Its gas
 * token is USDC and `0x3600…0000` is the same balance `eth_getBalance`
 * returns — so there is nothing to wrap, and Arc's SwapRouter02 reports a
 * WETH9() holding 53 bytes of stub, so there is nothing to call either.
 *
 * The decimals are the part that costs money. Native accounting on Arc is
 * 18-decimal wei; the ERC-20 view is 6. Resolving the native symbol at
 * `nativeDecimals` — which is what the `wrappedNative` branch does — would
 * turn "swap 1 USDC" into a request to spend 10^12 USDC, on the most common
 * trade on the chain.
 */
describe("Arc native ERC-20", () => {
  let provider: import("../../../src/services/dex/providers/uniswapV3.js").UniswapV3Provider;

  const AMOUNT_IN = 1;
  const MIN_OUT = 1000;
  const SENDER = "0x1111111111111111111111111111111111111111";
  // A real Arc ERC-20 (symbol() "WBTC" on chain 5042), given by address so
  // the test exercises the same unknown-token path a discovered token takes.
  const OTHER = "0x6dc7DCBf19e07884e4762E06fB62128eC806Eda1";
  // Literal, not read off the descriptor: a test that asserts a value
  // against itself passes however wrong the descriptor is.
  const USDC = "0x3600000000000000000000000000000000000000";

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.reset();
    ConfigManager.load();

    const { UniswapV3Provider } = await import("../../../src/services/dex/providers/uniswapV3.js");
    provider = new UniswapV3Provider(ARC_MAINNET);

    vi.spyOn(
      provider as unknown as {
        bestRoute: () => Promise<{ amountOut: bigint; tokens: unknown[]; fees: number[] }>;
      },
      "bestRoute"
    ).mockResolvedValue({ amountOut: 2_000_000n, tokens: [{}, {}], fees: [500] });

    vi.spyOn(
      provider as unknown as { publicClient: () => unknown },
      "publicClient"
    ).mockReturnValue({ readContract: vi.fn().mockResolvedValue(0n) });
  });

  it("resolves the native symbol to the ERC-20 that holds the same balance", async () => {
    const resolved = await (
      provider as unknown as {
        resolveToken: (s: string) => Promise<{ contractId: string; decimals: number } | null>;
      }
    ).resolveToken("USDC");
    expect(resolved?.contractId.toLowerCase()).toBe(USDC);
  });

  it("resolves it at the ERC-20's 6 decimals, not the chain's 18", async () => {
    // The whole reason `nativeErc20` is a separate field. 18 here is a
    // 10^12-times-too-large spend, not a rounding difference.
    const resolved = await (
      provider as unknown as {
        resolveToken: (s: string) => Promise<{ contractId: string; decimals: number } | null>;
      }
    ).resolveToken("USDC");
    expect(resolved?.decimals).toBe(6);
  });

  it("does not bracket the swap with wrap or unwrap calls", async () => {
    // approve + swap, and nothing else: no deposit to prepend, no withdraw to
    // append, because no wrapping happens.
    const payload = await provider.buildSwapPayload("USDC", OTHER, AMOUNT_IN, MIN_OUT, SENDER);
    expect(payload?.kind).toBe("evm");
    expect(payload!.calls!.length).toBe(2);
  });

  it("prices its gas token at a dollar rather than trying to route it", () => {
    // Arc is the first chain here whose native symbol equals its stable
    // symbol, which a conformance rule used to forbid outright on the grounds
    // that quoting a thing against itself has no route. It has none here
    // either — the identity is short-circuited before any routing is
    // attempted, on both the price path and limitOrder's trigger check.
    //
    // This matters beyond tidiness: the native row's USD value is what
    // RiskManager sizes positions against, so a null or zero here would cap
    // every Arc position at nothing.
    return expect(provider.getTokenPrice("USDC")).resolves.toBe(1);
  });

  it("sends no native value with the swap", async () => {
    // A native-value transfer is how the wrapped path funds a deposit. Here
    // the input is an ordinary ERC-20 spend, so any value attached would be
    // USDC leaving the wallet on top of the amount being swapped.
    const payload = await provider.buildSwapPayload("USDC", OTHER, AMOUNT_IN, MIN_OUT, SENDER);
    for (const call of payload!.calls!) {
      expect(call.value === undefined || BigInt(call.value) === 0n).toBe(true);
    }
  });
});
