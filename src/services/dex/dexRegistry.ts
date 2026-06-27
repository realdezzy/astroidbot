import { logger } from "../../utils/logger.js";
import type { DEXProvider, DEXQuote, TradingPair } from "../../types/dexProvider.js";
import type { SwappableToken } from "../../types.js";

export class DEXRegistry {
  private static instance: DEXRegistry;
  private providers: DEXProvider[] = [];

  private constructor() { }

  static getInstance(): DEXRegistry {
    if (!DEXRegistry.instance) {
      DEXRegistry.instance = new DEXRegistry();
    }
    return DEXRegistry.instance;
  }

  registerProvider(provider: DEXProvider) {
    if (this.providers.some((p) => p.name === provider.name)) {
      return;
    }
    this.providers.push(provider);
    logger.info(`[DEXRegistry] Registered provider: ${provider.name}`);
  }

  getProviders(): DEXProvider[] {
    return this.providers;
  }

  getProvider(name: string): DEXProvider | undefined {
    return this.providers.find((p) => p.name.toUpperCase() === name.toUpperCase());
  }

  async getBestQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: number
  ): Promise<{ providerName: string; quote: DEXQuote } | null> {
    let best: { providerName: string; quote: DEXQuote } | null = null;

    for (const provider of this.providers) {
      try {
        const hasRoute = await provider.hasRoute(tokenIn, tokenOut);
        if (!hasRoute) continue;

        const quote = await provider.getQuote(tokenIn, tokenOut, amountIn);
        if (quote.amountOut > 0) {
          if (!best) {
            best = { providerName: provider.name, quote };
          } else {
            const isCurrentBitflow = provider.name.toLowerCase() === "bitflow";
            const isBestBitflow = best.providerName.toLowerCase() === "bitflow";

            if (isCurrentBitflow && !isBestBitflow) {
              if (quote.amountOut >= best.quote.amountOut * 0.995) {
                best = { providerName: provider.name, quote };
              }
            } else if (!isCurrentBitflow && isBestBitflow) {
              if (quote.amountOut > best.quote.amountOut * 1.005) {
                best = { providerName: provider.name, quote };
              }
            } else {
              if (quote.amountOut > best.quote.amountOut) {
                best = { providerName: provider.name, quote };
              }
            }
          }
        }
      } catch (error) {
        logger.warn(`[DEXRegistry] Failed to get quote from ${provider.name}`, { error, tokenIn, tokenOut, amountIn });
      }
    }

    return best;
  }

  async getAllQuotes(
    tokenIn: string,
    tokenOut: string,
    amountIn: number
  ): Promise<Array<{ providerName: string; quote: DEXQuote; isBest: boolean }>> {
    const quotes: Array<{ providerName: string; quote: DEXQuote; isBest: boolean }> = [];
    const best = await this.getBestQuote(tokenIn, tokenOut, amountIn);

    for (const provider of this.providers) {
      try {
        const hasRoute = await provider.hasRoute(tokenIn, tokenOut);
        if (!hasRoute) continue;

        const quote = await provider.getQuote(tokenIn, tokenOut, amountIn);
        if (quote.amountOut > 0) {
          quotes.push({
            providerName: provider.name,
            quote,
            isBest: best ? best.providerName === provider.name : false,
          });
        }
      } catch (error) {
        logger.warn(`[DEXRegistry] Failed to get quote from ${provider.name}`, { error, tokenIn, tokenOut, amountIn });
      }
    }

    // Sort: best quote first, then ordered by descending amountOut
    return quotes.sort((a, b) => (a.isBest ? -1 : b.isBest ? 1 : b.quote.amountOut - a.quote.amountOut));
  }

  async getSwappableTokens(): Promise<SwappableToken[]> {
    const tokensMap = new Map<string, SwappableToken>();
    for (const provider of this.providers) {
      try {
        const tokens = await provider.getSwappableTokens();
        for (const t of tokens) {
          const key = t.symbol.toUpperCase();
          const existing = tokensMap.get(key);
          if (existing) {
            existing.supportedBy = existing.supportedBy || [];
            if (!existing.supportedBy.includes(provider.name)) {
              existing.supportedBy.push(provider.name);
            }
            const existingIsReal = existing.contractId.includes(".");
            const newIsReal = t.contractId.includes(".");
            if (newIsReal && !existingIsReal) {
              existing.contractId = t.contractId;
              existing.name = t.name;
              existing.decimals = t.decimals;
            }
          } else {
            tokensMap.set(key, {
              ...t,
              supportedBy: [provider.name],
            });
          }
        }
      } catch (error) {
        logger.warn(`[DEXRegistry] Failed to fetch swappable tokens from ${provider.name}`, { error });
      }
    }
    return Array.from(tokensMap.values());
  }

  async getTokenPrice(symbol: string): Promise<number> {
    for (const provider of this.providers) {
      try {
        const price = await provider.getTokenPrice(symbol);
        if (price > 0) return price;
      } catch { }
    }
    return 0;
  }

  /**
   * Returns the union of synchronously cached tokens across all providers.
   * Use for UI token pickers that need instant response without a network call.
   */
  getCachedTokens(): SwappableToken[] {
    const seen = new Map<string, SwappableToken>();
    for (const provider of this.providers) {
      if (provider.getCachedTokens) {
        for (const t of provider.getCachedTokens()) {
          const key = t.symbol.toUpperCase();
          const existing = seen.get(key);
          if (existing) {
            existing.supportedBy = existing.supportedBy || [];
            if (!existing.supportedBy.includes(provider.name)) {
              existing.supportedBy.push(provider.name);
            }
            const existingIsReal = existing.contractId.includes(".");
            const newIsReal = t.contractId.includes(".");
            if (newIsReal && !existingIsReal) {
              existing.contractId = t.contractId;
              existing.name = t.name;
              existing.decimals = t.decimals;
            }
          } else {
            seen.set(key, {
              ...t,
              supportedBy: [provider.name],
            });
          }
        }
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Returns the union of LP trading pairs across all providers that expose them.
   */
  getTradingPairs(): TradingPair[] {
    const seen = new Map<string, TradingPair>();
    for (const provider of this.providers) {
      if (provider.getTradingPairs) {
        for (const p of provider.getTradingPairs()) {
          seen.set(p.contractId, p);
        }
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Mid-price for a token pair via the best available route.
   * Falls back to 0 if no route exists across any provider.
   */
  async getPairPrice(tokenA: string, tokenB: string): Promise<{ midPrice: number; priceImpactBuy: number; priceImpactSell: number }> {
    const [fwd, rev] = await Promise.all([
      this.getBestQuote(tokenA, tokenB, 1).catch(() => null),
      this.getBestQuote(tokenB, tokenA, 1).catch(() => null),
    ]);

    const fwdOut = fwd?.quote.amountOut ?? 0;
    const revOut = rev?.quote.amountOut ?? 0;
    const midPrice = fwdOut > 0 ? fwdOut : revOut > 0 ? 1 / revOut : 0;

    return {
      midPrice,
      priceImpactBuy: fwd?.quote.priceImpact ?? 0,
      priceImpactSell: rev?.quote.priceImpact ?? 0,
    };
  }
}
