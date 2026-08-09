import type { SwappableToken } from "../../../types.js";
import type { DEXProvider, TradingPair } from "../../../types/dexProvider.js";
import type { ChainDescriptor } from "../../../types/chain.js";

/**
 * Caching and chain-identity behaviour shared by every DEX provider.
 *
 * Providers differ in how they quote and how they build a swap; they do not
 * differ in needing a short-lived price cache, a token lookup, or the ability
 * to say which network they route on. Hoisting that here means a new provider
 * is the interesting half only.
 */
export abstract class BaseDEXProvider implements DEXProvider {
  abstract name: string;

  /** Short TTL: long enough to collapse the ~10 round-trips one getBestQuote
   *  fans out into, short enough that a quote never prices off stale data. */
  protected static readonly PRICE_CACHE_TTL_MS = 15_000;

  private priceCache = new Map<string, { price: number; at: number }>();

  constructor(readonly descriptor: ChainDescriptor) { }

  get chainFamily(): string {
    return this.descriptor.family;
  }

  get chainId(): string {
    return this.descriptor.chainId;
  }

  protected cachedPrice(key: string): number | undefined {
    const hit = this.priceCache.get(key);
    if (hit && Date.now() - hit.at < BaseDEXProvider.PRICE_CACHE_TTL_MS) return hit.price;
    return undefined;
  }

  protected cachePrice(key: string, price: number): number {
    this.priceCache.set(key, { price, at: Date.now() });
    return price;
  }

  /** Most providers have no live pool-reserve fetching; those that do override. */
  getTradingPairs(): TradingPair[] {
    return [];
  }

  abstract getSwappableTokens(refresh?: boolean): Promise<SwappableToken[]>;
  abstract getCachedTokens(): SwappableToken[];
  abstract hasRoute(tokenIn: string, tokenOut: string): Promise<boolean>;
  abstract getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: number
  ): ReturnType<DEXProvider["getQuote"]>;
  abstract getTokenPrice(tokenSymbol: string): Promise<number>;
  abstract buildSwapPayload(
    tokenIn: string,
    tokenOut: string,
    amountIn: number,
    minAmountOut: number,
    senderAddress: string
  ): ReturnType<DEXProvider["buildSwapPayload"]>;
}
