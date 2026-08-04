import {
  createPublicClient,
  defineChain,
  http,
  encodeFunctionData,
  parseUnits,
  formatUnits,
  type Address,
  type PublicClient,
} from "viem";
import { logger } from "../../../utils/logger.js";
import type { SwappableToken, TransactionPayload } from "../../../types.js";
import type { DEXQuote } from "../../../types/dexProvider.js";
import {
  ERC20_ABI,
  UNISWAP_V3_QUOTER_V2_ABI,
  UNISWAP_V3_ROUTER_ABI,
  WRAPPED_NATIVE_ABI,
} from "../../chains/evm/abis.js";
import { CircuitBreakerRegistry } from "../../../utils/circuitBreaker.js";
import { toDecimalString } from "../../../utils/decimal.js";
import { BaseDEXProvider } from "./baseDexProvider.js";
import { requireEvmConfig, type ChainDescriptor } from "../../../types/chain.js";

/**
 * Uniswap V3 and its forks, on any EVM chain.
 *
 * The QuoterV2 fee-tier scan, exactInputSingle payload building and
 * allowance-aware approve batching are identical for every V3 deployment —
 * only addresses and the token list differ, and those live in the chain's
 * descriptor. Base, Celo (Ubeswap) and any V3 fork declared through
 * CUSTOM_EVM_CHAINS share this one implementation.
 *
 * Native-asset trades are handled here rather than pushed onto callers: naming
 * the chain's native symbol resolves to its wrapped form, and the payload
 * gains a deposit call before the swap and a withdraw after it as needed.
 * Under ERC-4337 the whole sequence is one atomic UserOperation, so a
 * half-wrapped balance can't be stranded.
 */
export class UniswapV3Provider extends BaseDEXProvider {
  readonly name: string;
  private readonly evm: ReturnType<typeof requireEvmConfig>;
  private readonly tokenList: SwappableToken[];

  // Remembers which fee tier actually had a pool for a pair, so the common
  // hasRoute-then-getQuote sequence doesn't re-probe the missing tiers each
  // time. Pool existence per tier doesn't change, so this needs no TTL.
  private feeTierCache = new Map<string, number>();

  constructor(descriptor: ChainDescriptor) {
    super(descriptor);
    this.evm = requireEvmConfig(descriptor);

    if (!this.evm.dex) {
      throw new Error(
        `Chain ${descriptor.chainId} has no DEX configured — it cannot back a UniswapV3Provider`
      );
    }

    // Name is per-chain so DEXRegistry (which dedupes by name) can hold a
    // provider for every chain simultaneously. A shared "UniswapV3" name would
    // mean the second chain's provider is silently dropped at registration —
    // the same class of bug as the family-keyed adapter registry.
    this.name = `${this.evm.dex.name}-${descriptor.chainId}`;

    this.tokenList = Object.entries(this.evm.tokens ?? {}).map(([symbol, t]) => ({
      contractId: t.address,
      symbol,
      name: t.name,
      decimals: t.decimals,
      chainFamily: descriptor.family,
      chainId: descriptor.chainId,
    }));
  }

  private get dex() {
    return this.evm.dex!;
  }

  private get breaker() {
    return CircuitBreakerRegistry.getBreaker(this.name);
  }

  private rpcUrl(): string {
    const key = `RPC_URL_${this.descriptor.chainId.toUpperCase().replace(/[:-]/g, "_")}`;
    return process.env[key] || this.evm.defaultRpcUrl;
  }

  private publicClient(): PublicClient {
    const chain = defineChain({
      id: this.evm.id,
      name: this.descriptor.displayName,
      nativeCurrency: {
        name: this.descriptor.nativeSymbol,
        symbol: this.descriptor.nativeSymbol,
        decimals: this.descriptor.nativeDecimals,
      },
      rpcUrls: { default: { http: [this.rpcUrl()] } },
      testnet: this.descriptor.isTestnet,
    });
    return createPublicClient({ chain, transport: http(this.rpcUrl()) }) as PublicClient;
  }

  /** True when the caller named the chain's native asset (ETH, CELO, …). */
  private isNative(symbolOrAddress: string): boolean {
    return symbolOrAddress.toUpperCase() === this.descriptor.nativeSymbol.toUpperCase();
  }

  /**
   * Decimals for tokens outside the curated list. Permanent — an ERC-20's
   * decimals cannot change, so there is nothing to invalidate.
   */
  private decimalsCache = new Map<string, number>();

  /**
   * Reads an unknown token's decimals on-chain.
   *
   * Returns null rather than a default when the read fails. Guessing is not
   * safe here: `decimals` scales the *amount being spent*. Assuming 18 for a
   * 6-decimal token turns "swap 1 token" into `parseUnits("1", 18)` — a
   * request to spend 10^12 times more than the user asked for. Refusing to
   * resolve costs a "no route"; guessing can cost funds.
   */
  private async fetchDecimals(address: string): Promise<number | null> {
    const key = address.toLowerCase();
    const cached = this.decimalsCache.get(key);
    if (cached !== undefined) return cached;

    try {
      const raw = await this.publicClient().readContract({
        address: key as Address,
        abi: ERC20_ABI,
        functionName: "decimals",
      });

      const decimals = Number(raw);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;

      this.decimalsCache.set(key, decimals);
      return decimals;
    } catch {
      return null;
    }
  }

  private async resolveToken(symbolOrAddress: string): Promise<SwappableToken | null> {
    // Uniswap pools hold only ERC-20s, so the native asset routes through its
    // wrapped form. Without this, asking to trade ETH resolved to nothing and
    // reported "no route" on a pair with deep liquidity.
    if (this.isNative(symbolOrAddress) && this.evm.wrappedNative) {
      return {
        contractId: this.evm.wrappedNative,
        symbol: this.descriptor.nativeSymbol,
        name: `Wrapped ${this.descriptor.nativeSymbol}`,
        decimals: this.descriptor.nativeDecimals,
        chainFamily: this.descriptor.family,
        chainId: this.descriptor.chainId,
      };
    }

    const needle = symbolOrAddress.toLowerCase();
    const known = this.tokenList.find(
      (t) => t.symbol.toLowerCase() === needle || t.contractId.toLowerCase() === needle
    );
    if (known) return known;

    // Unknown ERC-20 address. Its decimals are read from the contract rather
    // than assumed: token discovery now surfaces the long tail of tokens that
    // were never in the curated list, each with a Trade button, so "unknown
    // address" went from a rare edge case to the common path. A symbol we
    // don't recognise still fails to resolve — there's nothing to read it off.
    if (symbolOrAddress.startsWith("0x") && symbolOrAddress.length === 42) {
      const decimals = await this.fetchDecimals(symbolOrAddress);
      if (decimals === null) return null;

      return {
        contractId: symbolOrAddress,
        symbol: symbolOrAddress,
        name: symbolOrAddress,
        decimals,
        chainFamily: this.descriptor.family,
        chainId: this.descriptor.chainId,
      };
    }
    return null;
  }

  async getSwappableTokens(_refresh = false): Promise<SwappableToken[]> {
    return this.tokenList;
  }

  getCachedTokens(): SwappableToken[] {
    return this.tokenList;
  }

  private async quoteRaw(
    tokenIn: SwappableToken,
    tokenOut: SwappableToken,
    amountInRaw: bigint
  ): Promise<{ amountOut: bigint; fee: number } | null> {
    const client = this.publicClient();
    const pairKey = `${tokenIn.contractId.toLowerCase()}:${tokenOut.contractId.toLowerCase()}`;
    const knownFee = this.feeTierCache.get(pairKey);
    const tiers =
      knownFee !== undefined
        ? [knownFee, ...this.dex.feeTiers.filter((f) => f !== knownFee)]
        : [...this.dex.feeTiers];

    for (const fee of tiers) {
      try {
        const { result } = await this.breaker.execute(() =>
          client.simulateContract({
            address: this.dex.quoter,
            abi: UNISWAP_V3_QUOTER_V2_ABI,
            functionName: "quoteExactInputSingle",
            args: [
              {
                tokenIn: tokenIn.contractId as Address,
                tokenOut: tokenOut.contractId as Address,
                amountIn: amountInRaw,
                fee,
                sqrtPriceLimitX96: 0n,
              },
            ],
          })
        );
        const [amountOut] = result as readonly [bigint, bigint, number, bigint];
        if (amountOut > 0n) {
          this.feeTierCache.set(pairKey, fee);
          return { amountOut, fee };
        }
      } catch {
        // No pool at this fee tier (or insufficient liquidity) — try the next.
      }
    }
    return null;
  }

  async hasRoute(tokenIn: string, tokenOut: string): Promise<boolean> {
    const [tIn, tOut] = await Promise.all([
      this.resolveToken(tokenIn),
      this.resolveToken(tokenOut),
    ]);
    if (!tIn || !tOut) return false;
    const probe = parseUnits("1", tIn.decimals);
    return (await this.quoteRaw(tIn, tOut, probe)) !== null;
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    const token = await this.resolveToken(tokenSymbol);
    const stable = this.tokenList.find((t) => t.symbol === this.descriptor.stableSymbol);
    if (!token || !stable) return 0;
    if (token.contractId.toLowerCase() === stable.contractId.toLowerCase()) return 1;

    const cacheKey = token.contractId.toLowerCase();
    const cached = this.cachedPrice(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const probe = parseUnits("1", token.decimals);
      const result = await this.quoteRaw(token, stable, probe);
      if (!result) return 0;
      return this.cachePrice(cacheKey, Number(formatUnits(result.amountOut, stable.decimals)));
    } catch {
      return 0;
    }
  }

  async getQuote(tokenIn: string, tokenOut: string, amountIn: number): Promise<DEXQuote> {
    const [tIn, tOut] = await Promise.all([
      this.resolveToken(tokenIn),
      this.resolveToken(tokenOut),
    ]);
    if (!tIn || !tOut || amountIn <= 0) {
      return { amountOut: 0, priceImpact: 0, feeBps: 0, feeAmount: 0 };
    }

    try {
      const amountInRaw = parseUnits(toDecimalString(amountIn), tIn.decimals);
      const result = await this.quoteRaw(tIn, tOut, amountInRaw);
      if (!result) return { amountOut: 0, priceImpact: 0, feeBps: 0, feeAmount: 0 };

      const amountOut = Number(formatUnits(result.amountOut, tOut.decimals));
      // Uniswap fee is in hundredths of a bip (1e-6 of amountIn); bps is 1e-4.
      const feeBps = result.fee / 100;
      const feeAmount = amountIn * (result.fee / 1_000_000);

      const [priceIn, priceOut] = await Promise.all([
        this.getTokenPrice(tokenIn),
        this.getTokenPrice(tokenOut),
      ]);
      let priceImpact = 0;
      if (priceIn > 0 && priceOut > 0 && amountOut > 0) {
        const spotPrice = priceIn / priceOut;
        const executionPrice = amountIn / amountOut;
        priceImpact = Math.abs(1 - executionPrice / spotPrice) * 100;
      }

      return { amountOut, priceImpact: Math.round(priceImpact * 100) / 100, feeBps, feeAmount };
    } catch (err) {
      logger.warn(`${this.name} getQuote failed`, {
        tokenIn,
        tokenOut,
        amountIn,
        error: err instanceof Error ? err.message : String(err),
      });
      return { amountOut: 0, priceImpact: 0, feeBps: 0, feeAmount: 0 };
    }
  }

  async buildSwapPayload(
    tokenIn: string,
    tokenOut: string,
    amountIn: number,
    minAmountOut: number,
    senderAddress: string
  ): Promise<TransactionPayload | null> {
    const [tIn, tOut] = await Promise.all([
      this.resolveToken(tokenIn),
      this.resolveToken(tokenOut),
    ]);
    if (!tIn || !tOut) return null;

    try {
      const amountInRaw = parseUnits(toDecimalString(amountIn), tIn.decimals);
      const result = await this.quoteRaw(tIn, tOut, amountInRaw);
      if (!result) return null;

      const amountOutMinimumRaw = parseUnits(toDecimalString(minAmountOut), tOut.decimals);
      const router = this.dex.swapRouter;

      const swapData = encodeFunctionData({
        abi: UNISWAP_V3_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: tIn.contractId as Address,
            tokenOut: tOut.contractId as Address,
            fee: result.fee,
            recipient: senderAddress as Address,
            amountIn: amountInRaw,
            amountOutMinimum: amountOutMinimumRaw,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });

      const calls: { to: string; data: string; value?: string }[] = [];

      const wrapsIn = this.isNative(tokenIn) && !!this.evm.wrappedNative;
      const unwrapsOut = this.isNative(tokenOut) && !!this.evm.wrappedNative;

      // Wrap first: the swap spends the wrapped token, so the deposit has to
      // land before it. Under ERC-4337 all of this is one atomic
      // UserOperation, so a partially-wrapped balance can't be left behind.
      if (wrapsIn) {
        const depositData = encodeFunctionData({ abi: WRAPPED_NATIVE_ABI, functionName: "deposit" });
        calls.push({
          to: this.evm.wrappedNative!,
          data: depositData,
          value: amountInRaw.toString(),
        });
      }

      // Only include the approval call if the account's current allowance to
      // the router is insufficient — avoids a redundant approve on every swap
      // once one large approval has gone through.
      // A fresh wrap means the balance is new and unapproved, so skip the
      // allowance read and always approve.
      const currentAllowance = wrapsIn ? 0n : await this.breaker
        .execute(() =>
          this.publicClient().readContract({
            address: tIn.contractId as Address,
            abi: ERC20_ABI,
            functionName: "allowance",
            args: [senderAddress as Address, router],
          })
        )
        .catch(() => 0n);

      if (currentAllowance < amountInRaw) {
        const approveData = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [router, amountInRaw],
        });
        calls.push({ to: tIn.contractId, data: approveData });
      }

      calls.push({ to: router, data: swapData, value: "0" });

      // Unwrap after the swap so the user ends up holding the native asset
      // they asked for rather than its wrapped form.
      if (unwrapsOut) {
        const withdrawData = encodeFunctionData({
          abi: WRAPPED_NATIVE_ABI,
          functionName: "withdraw",
          args: [amountOutMinimumRaw],
        });
        calls.push({ to: this.evm.wrappedNative!, data: withdrawData });
      }

      return { kind: "evm", calls };
    } catch (err) {
      logger.warn(`${this.name} buildSwapPayload failed`, {
        tokenIn,
        tokenOut,
        amountIn,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
