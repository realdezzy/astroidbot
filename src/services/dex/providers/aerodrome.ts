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
  AERODROME_SLIPSTREAM_QUOTER_ABI,
  AERODROME_SLIPSTREAM_ROUTER_ABI,
  WRAPPED_NATIVE_ABI,
} from "../../chains/evm/abis.js";
import { CircuitBreakerRegistry } from "../../../utils/circuitBreaker.js";
import { toDecimalString } from "../../../utils/decimal.js";
import { BaseDEXProvider } from "./baseDexProvider.js";
import { requireEvmConfig, type ChainDescriptor } from "../../../types/chain.js";
import { rpcUrlOverride } from "../../chains/evm/evmClient.js";
import { stocksForChain } from "../../stocks/stockRegistry.js";

/** One Slipstream factory with the router and quoter bound to it. */
interface SlipstreamDeployment {
  factory: Address;
  router: Address;
  quoter: Address;
  tickSpacings: number[];
}

/** A quote that also records which pool produced it, so the swap can use it. */
interface SlipstreamQuote {
  amountOut: bigint;
  tickSpacing: number;
  router: Address;
}

/**
 * Whether a failed quote means "no pool here" rather than "the provider is
 * broken".
 *
 * A quoter reverts for a tick spacing that has no pool, and most (factory, tick
 * spacing) combinations have no pool — probing is expected to revert far more
 * often than it succeeds. Counting those as circuit-breaker failures opened the
 * breaker during a single quote and short-circuited every later probe, so the
 * deep factory (tried last) was never reached and the stock route looked dead.
 */
function isNoPoolRevert(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /revert/i.test(message);
}

/**
 * Aerodrome Slipstream — Base's concentrated-liquidity AMM.
 *
 * Separate from `UniswapV3Provider` despite the shared lineage: Slipstream
 * replaced Uniswap V3's `fee` with `tickSpacing`, so quoting and swapping take
 * different calldata and the tick spacing has to be discovered per pair. It is
 * also where the tokenized-stock liquidity is, which the Uniswap pools of the
 * same pairs do not match.
 *
 * A router is bound to one factory, and Aerodrome has run three CL factories,
 * so probing a pair means probing each factory's router separately. The result
 * records which router answered; the swap must go through that one, not
 * whichever the descriptor happens to list first.
 */
export class AerodromeProvider extends BaseDEXProvider {
  readonly name: string;
  private readonly evm: ReturnType<typeof requireEvmConfig>;
  private readonly deployments: SlipstreamDeployment[];
  private readonly tokenList: SwappableToken[];

  /** Permanent — an ERC-20's decimals cannot change. */
  private readonly decimalsCache = new Map<string, number>();
  /** Which tick spacing had a pool, keyed by factory and pair. Pools don't move. */
  private readonly tickCache = new Map<string, number>();

  constructor(descriptor: ChainDescriptor) {
    super(descriptor);
    this.evm = requireEvmConfig(descriptor);

    const slipstream = this.evm.aerodrome?.slipstream ?? [];
    if (slipstream.length === 0) {
      throw new Error(
        `Chain ${descriptor.chainId} has no Aerodrome Slipstream deployment — it cannot back an AerodromeProvider`
      );
    }

    this.deployments = slipstream.map((d) => ({
      factory: d.factory as Address,
      router: d.router as Address,
      quoter: d.quoter as Address,
      tickSpacings: d.tickSpacings,
    }));

    // Per-chain name, for the same reason every other provider is: DEXRegistry
    // dedupes by name and would otherwise drop the second chain's provider.
    this.name = `Aerodrome-${descriptor.chainId}`;

    // Descriptor tokens plus the curated stock allowlist, so a stock can be
    // picked by symbol rather than pasted as an address.
    this.tokenList = [
      ...Object.entries(this.evm.tokens ?? {}).map(([symbol, t]) => ({
        contractId: t.address,
        symbol,
        name: t.name,
        decimals: t.decimals,
        chainFamily: descriptor.family,
        chainId: descriptor.chainId,
      })),
      ...stocksForChain(descriptor.chainId).map((s) => ({
        contractId: s.contractId,
        symbol: s.symbol,
        name: s.name,
        decimals: s.decimals,
        chainFamily: descriptor.family,
        chainId: descriptor.chainId,
      })),
    ];
  }

  private get breaker() {
    return CircuitBreakerRegistry.getBreaker(this.name);
  }

  private rpcUrl(): string {
    return rpcUrlOverride(this.descriptor.chainId, this.evm.defaultRpcUrl);
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

  private isNative(symbolOrAddress: string): boolean {
    return symbolOrAddress.toUpperCase() === this.descriptor.nativeSymbol.toUpperCase();
  }

  private wrappedToken(): SwappableToken | null {
    if (!this.evm.wrappedNative) return null;
    return {
      contractId: this.evm.wrappedNative,
      symbol: this.descriptor.nativeSymbol,
      name: `Wrapped ${this.descriptor.nativeSymbol}`,
      decimals: this.descriptor.nativeDecimals,
      chainFamily: this.descriptor.family,
      chainId: this.descriptor.chainId,
    };
  }

  /**
   * Reads an unknown token's decimals on-chain.
   *
   * Null rather than a default: decimals scale the amount actually spent, so
   * guessing 18 for a 6-decimal token asks to spend 10^12 times more than the
   * user typed. A failed read costs a "no route"; a wrong one costs funds.
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
    // Slipstream holds only ERC-20s, so the native asset routes through WETH.
    if (this.isNative(symbolOrAddress)) return this.wrappedToken();

    const needle = symbolOrAddress.toLowerCase();
    const known = this.tokenList.find(
      (t) => t.symbol.toLowerCase() === needle || t.contractId.toLowerCase() === needle
    );
    if (known) return known;

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

  /**
   * The best single-pool quote across every deployment.
   *
   * Single-hop only, like the Uniswap providers here: the deep stock pairs are
   * quoted directly against a stable, so a multi-hop path would add failure
   * modes without adding routes this product needs.
   */
  private async quoteBest(
    tokenIn: SwappableToken,
    tokenOut: SwappableToken,
    amountInRaw: bigint
  ): Promise<SlipstreamQuote | null> {
    const client = this.publicClient();

    // One breaker execution for the whole probe, not one per tier: a quote
    // legitimately reverts across every empty (factory, tick spacing) pair, and
    // those misses are data. A transport failure still throws out of the loop
    // and is counted — once — by the breaker.
    return this.breaker.execute(async () => {
      let best: SlipstreamQuote | null = null;

      for (const deployment of this.deployments) {
        const cacheKey = `${deployment.factory}:${tokenIn.contractId.toLowerCase()}:${tokenOut.contractId.toLowerCase()}`;
        const known = this.tickCache.get(cacheKey);
        const tiers =
          known !== undefined
            ? [known, ...deployment.tickSpacings.filter((t) => t !== known)]
            : [...deployment.tickSpacings];

        for (const tickSpacing of tiers) {
          try {
            const { result } = await client.simulateContract({
              address: deployment.quoter,
              abi: AERODROME_SLIPSTREAM_QUOTER_ABI,
              functionName: "quoteExactInputSingle",
              args: [
                {
                  tokenIn: tokenIn.contractId as Address,
                  tokenOut: tokenOut.contractId as Address,
                  amountIn: amountInRaw,
                  tickSpacing,
                  sqrtPriceLimitX96: 0n,
                },
              ],
            });
            const amountOut = (result as readonly [bigint, bigint, number, bigint])[0];
            if (amountOut > 0n) {
              this.tickCache.set(cacheKey, tickSpacing);
              if (!best || amountOut > best.amountOut) {
                best = { amountOut, tickSpacing, router: deployment.router };
              }
              break; // First hit on this factory is its best tier for the pair.
            }
          } catch (error) {
            // No pool at this tick spacing — try the next. Only a non-revert
            // failure (RPC down, rate-limited) is allowed to trip the breaker.
            if (isNoPoolRevert(error)) continue;
            throw error;
          }
        }
      }

      return best;
    });
  }

  async hasRoute(tokenIn: string, tokenOut: string): Promise<boolean> {
    const [tIn, tOut] = await Promise.all([this.resolveToken(tokenIn), this.resolveToken(tokenOut)]);
    if (!tIn || !tOut) return false;
    const probe = parseUnits("1", tIn.decimals);
    return (await this.quoteBest(tIn, tOut, probe)) !== null;
  }

  async getTokenPrice(tokenSymbol: string): Promise<number | null> {
    const token = await this.resolveToken(tokenSymbol);
    const stable = this.tokenList.find((t) => t.symbol === this.descriptor.stableSymbol);
    if (!token || !stable) return null;
    if (token.contractId.toLowerCase() === stable.contractId.toLowerCase()) return 1;

    const cacheKey = token.contractId.toLowerCase();
    const cached = this.cachedPrice(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const probe = parseUnits("1", token.decimals);
      const result = await this.quoteBest(token, stable, probe);
      if (!result) return null;
      return this.cachePrice(cacheKey, Number(formatUnits(result.amountOut, stable.decimals)));
    } catch {
      return null;
    }
  }

  async getQuote(tokenIn: string, tokenOut: string, amountIn: number): Promise<DEXQuote> {
    const empty: DEXQuote = { amountOut: 0, priceImpact: 0, feeBps: 0, feeAmount: 0 };
    const [tIn, tOut] = await Promise.all([this.resolveToken(tokenIn), this.resolveToken(tokenOut)]);
    if (!tIn || !tOut || amountIn <= 0) return empty;

    try {
      const amountInRaw = parseUnits(toDecimalString(amountIn), tIn.decimals);
      const result = await this.quoteBest(tIn, tOut, amountInRaw);
      if (!result) return empty;

      const amountOut = Number(formatUnits(result.amountOut, tOut.decimals));

      // Slipstream's fee is set per pool and paid in the input token. The exact
      // basis points are not recoverable from a single quote without a second
      // read, and are not used for execution — only reported.
      const [priceIn, priceOut] = await Promise.all([
        this.getTokenPrice(tokenIn),
        this.getTokenPrice(tokenOut),
      ]);
      let priceImpact = 0;
      // Null is unpriceable; 0 is unusable as a divisor. Neither yields an impact.
      if (priceIn && priceOut && amountOut > 0) {
        const spotPrice = priceIn / priceOut;
        const executionPrice = amountOut / amountIn;
        priceImpact = Math.abs(1 - executionPrice / spotPrice) * 100;
      }

      return {
        amountOut,
        priceImpact: Math.round(priceImpact * 100) / 100,
        feeBps: 0,
        feeAmount: 0,
      };
    } catch (err) {
      logger.warn(`${this.name} getQuote failed`, {
        tokenIn,
        tokenOut,
        amountIn,
        error: err instanceof Error ? err.message : String(err),
      });
      return empty;
    }
  }

  async buildSwapPayload(
    tokenIn: string,
    tokenOut: string,
    amountIn: number,
    minAmountOut: number,
    senderAddress: string
  ): Promise<TransactionPayload | null> {
    const [tIn, tOut] = await Promise.all([this.resolveToken(tokenIn), this.resolveToken(tokenOut)]);
    if (!tIn || !tOut) return null;

    const wrapped = this.wrappedToken();
    const wrapsIn = this.isNative(tokenIn) && wrapped !== null;
    const unwrapsOut = this.isNative(tokenOut) && wrapped !== null;
    const swapIn = wrapsIn && wrapped ? wrapped : tIn;
    const swapOut = unwrapsOut && wrapped ? wrapped : tOut;

    try {
      const amountInRaw = parseUnits(toDecimalString(amountIn), swapIn.decimals);
      const result = await this.quoteBest(swapIn, swapOut, amountInRaw);
      if (!result) return null;

      const amountOutMinimumRaw = parseUnits(toDecimalString(minAmountOut), swapOut.decimals);
      const router = result.router;

      const swapData = encodeFunctionData({
        abi: AERODROME_SLIPSTREAM_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: swapIn.contractId as Address,
            tokenOut: swapOut.contractId as Address,
            tickSpacing: result.tickSpacing,
            recipient: senderAddress as Address,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
            amountIn: amountInRaw,
            amountOutMinimum: amountOutMinimumRaw,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });

      const calls: { to: string; data: string; value?: string }[] = [];

      // Wrap first: the swap spends WETH, so the deposit has to land before it.
      if (wrapsIn && wrapped) {
        calls.push({
          to: wrapped.contractId,
          data: encodeFunctionData({ abi: WRAPPED_NATIVE_ABI, functionName: "deposit" }),
          value: amountInRaw.toString(),
        });
      }

      // Only approve when the current allowance is short. A fresh wrap is
      // always unapproved, so skip the read and approve unconditionally.
      const currentAllowance = wrapsIn
        ? 0n
        : await this.breaker
            .execute(() =>
              this.publicClient().readContract({
                address: swapIn.contractId as Address,
                abi: ERC20_ABI,
                functionName: "allowance",
                args: [senderAddress as Address, router],
              })
            )
            .catch(() => 0n);

      if (currentAllowance < amountInRaw) {
        calls.push({
          to: swapIn.contractId,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "approve",
            args: [router, amountInRaw],
          }),
        });
      }

      calls.push({ to: router, data: swapData, value: "0" });

      // Unwrap after the swap so the user holds the native asset they asked for.
      if (unwrapsOut && wrapped) {
        calls.push({
          to: wrapped.contractId,
          data: encodeFunctionData({
            abi: WRAPPED_NATIVE_ABI,
            functionName: "withdraw",
            args: [amountOutMinimumRaw],
          }),
        });
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
