import { describe, it, expect, beforeAll, vi } from "vitest";
import { decodeFunctionData } from "viem";
import { ConfigManager } from "../../../src/config.js";
import { BASE_MAINNET } from "../../../src/services/chains/descriptors/base.js";
import { WRAPPED_NATIVE_ABI } from "../../../src/services/chains/evm/abis.js";

/**
 * D12: Base supported only ERC-20-to-ERC-20 swaps, so a user asking to trade
 * their native ETH got "no route found" on a pair with deep liquidity — the
 * native symbol simply resolved to nothing. Uniswap pools hold only ERC-20s,
 * so the fix is to route the native asset through its wrapped form and bracket
 * the swap with deposit/withdraw calls.
 *
 * One implementation serves every EVM chain, which is why this lives in
 * UniswapV3Provider rather than in a Base-specific class.
 */
describe("native asset wrapping", () => {
  let provider: import("../../../src/services/dex/providers/uniswapV3.js").UniswapV3Provider;

  const AMOUNT_IN = 1;
  const MIN_OUT = 1000;
  const SENDER = "0x1111111111111111111111111111111111111111";
  const WETH = BASE_MAINNET.evm!.wrappedNative!.toLowerCase();

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.reset();
    ConfigManager.load();

    const { UniswapV3Provider } = await import("../../../src/services/dex/providers/uniswapV3.js");
    provider = new UniswapV3Provider(BASE_MAINNET);

    // Stub the chain reads: this is about payload construction, not RPC.
    vi.spyOn(
      provider as unknown as { quoteRaw: () => Promise<{ amountOut: bigint; fee: number }> },
      "quoteRaw"
    ).mockResolvedValue({ amountOut: 2_000_000n, fee: 500 });

    vi.spyOn(
      provider as unknown as { publicClient: () => unknown },
      "publicClient"
    ).mockReturnValue({ readContract: vi.fn().mockResolvedValue(0n) });
  });

  it("resolves the native symbol to the wrapped token so a route exists at all", async () => {
    // This is the bug: "ETH" resolved to null, every tier missed, and the user
    // saw "no route" on the deepest pair on the chain.
    const resolved = (
      provider as unknown as { resolveToken: (s: string) => { contractId: string } | null }
    ).resolveToken("ETH");
    expect(resolved?.contractId.toLowerCase()).toBe(WETH);
  });

  it("prepends a deposit call when spending the native asset", async () => {
    const payload = await provider.buildSwapPayload("ETH", "USDC", AMOUNT_IN, MIN_OUT, SENDER);
    expect(payload?.kind).toBe("evm");

    const first = payload!.calls![0]!;
    expect(first.to.toLowerCase()).toBe(WETH);
    // The wrap must carry the native value, or nothing is actually wrapped.
    expect(BigInt(first.value!)).toBe(10n ** 18n);
    expect(decodeFunctionData({ abi: WRAPPED_NATIVE_ABI, data: first.data as `0x${string}` })
      .functionName).toBe("deposit");
  });

  it("orders the wrap before the swap", async () => {
    // The swap spends the wrapped token, so a deposit landing after it would
    // revert on an insufficient balance.
    const payload = await provider.buildSwapPayload("ETH", "USDC", AMOUNT_IN, MIN_OUT, SENDER);
    const router = BASE_MAINNET.evm!.dex!.swapRouter.toLowerCase();
    const swapIndex = payload!.calls!.findIndex((c) => c.to.toLowerCase() === router);
    expect(swapIndex).toBeGreaterThan(0);
  });

  it("appends a withdraw call when receiving the native asset", async () => {
    const payload = await provider.buildSwapPayload("USDC", "ETH", AMOUNT_IN, MIN_OUT, SENDER);
    const last = payload!.calls![payload!.calls!.length - 1]!;

    expect(last.to.toLowerCase()).toBe(WETH);
    expect(decodeFunctionData({ abi: WRAPPED_NATIVE_ABI, data: last.data as `0x${string}` })
      .functionName).toBe("withdraw");
  });

  it("does not wrap or unwrap for a plain ERC-20 pair", async () => {
    const payload = await provider.buildSwapPayload("USDC", "DAI", AMOUNT_IN, MIN_OUT, SENDER);
    const touchesWrapper = payload!.calls!.some((c) => c.to.toLowerCase() === WETH);
    expect(touchesWrapper).toBe(false);
  });

  it("still approves the router when the input was freshly wrapped", async () => {
    // A fresh wrap means a brand-new balance with no allowance, so skipping
    // the approve would make the swap revert.
    const payload = await provider.buildSwapPayload("ETH", "USDC", AMOUNT_IN, MIN_OUT, SENDER);
    // deposit + approve + swap
    expect(payload!.calls!.length).toBe(3);
  });
});
