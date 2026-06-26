import { BitflowSDK } from "@bitflowlabs/core-sdk";
import type { Token as BitflowToken, SelectedSwapRoute, QuoteResult as BitflowQuoteResult } from "@bitflowlabs/core-sdk";
import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";
import type { SwappableToken, TransactionPayload } from "../../types.js";
import type { DEXProvider, DEXQuote, TradingPair } from "../../types/dexProvider.js";

interface LocalPool {
  tokenXId: string;
  tokenYId: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tokenXContract: string | null;
  tokenYContract: string | null;
  decimals: number;
  feeRate: number;
}

export class BitflowDEXService implements DEXProvider {
  name = "Bitflow";
  private static instance: BitflowDEXService;
  private sdk: BitflowSDK | null = null;
  private sdkInitFailed = false;
  private tokens: SwappableToken[] = [];
  private pools: LocalPool[] = [];
  private cacheExpiry = 0;
  private readonly CACHE_TTL_MS = 3 * 60 * 60 * 1000;

  private constructor() {
  }

  private getSDK(): BitflowSDK | null {
    if (this.sdk) return this.sdk;
    if (this.sdkInitFailed) return null;

    try {
      this.sdk = new BitflowSDK({
        BITFLOW_API_HOST: "https://bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev",
        READONLY_CALL_API_HOST: "https://node.bitflowapis.finance",
      });
      return this.sdk;
    } catch (error) {
      logger.error("Failed to initialize BitflowSDK", { error });
      this.sdkInitFailed = true;
      return null;
    }
  }

  static initialize(): BitflowDEXService {
    if (!BitflowDEXService.instance) {
      BitflowDEXService.instance = new BitflowDEXService();
    }
    return BitflowDEXService.instance;
  }

  static getInstance(): BitflowDEXService {
    if (!BitflowDEXService.instance) {
      throw new Error("BitflowDEXService not initialized.");
    }
    return BitflowDEXService.instance;
  }

  async getPools(refresh = false): Promise<LocalPool[]> {
    const now = Date.now();
    if (!refresh && this.pools.length > 0 && now < this.cacheExpiry) {
      return this.pools;
    }

    try {
      const sdk = this.getSDK();
      if (!sdk) return this.pools;
      const sdkTokens = await sdk.getAvailableTokens();
      const tokenMap = new Map(sdkTokens.map((t) => [t.tokenId, t]));

      this.tokens = sdkTokens.map((t) => {
        const isStx = t.symbol.toUpperCase() === "STX" || t.tokenId === "token-stx";
        return {
          contractId: isStx ? "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx" : (t.tokenContract ?? t.tokenId),
          symbol: t.symbol,
          name: t.name,
          decimals: t.tokenDecimals,
        };
      });

      // Derive pairs from possible swaps of popular/active tokens to prevent timeouts and rate-limiting
      const seenPairs = new Set<string>();
      const newPools: LocalPool[] = [];

      const popularSymbols = new Set([
        "STX", "WSTX", "ALEX", "WALEX", "USDA", "WUSDA", "XBTC", "WBTC", "AEWBTC", "LEO", "DIKO", "WELAR", "ROO", "WELSH"
      ]);
      const targetTokens = sdkTokens.filter((t) => {
        const sym = t.symbol.toUpperCase();
        const id = t.tokenId.replace("token-", "").toUpperCase();
        return popularSymbols.has(sym) || popularSymbols.has(id);
      });

      // Fetch possible swaps in batches of 25 in parallel to optimize startup time
      const batchSize = 25;
      for (let i = 0; i < targetTokens.length; i += batchSize) {
        const batch = targetTokens.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (token) => {
            try {
              const swaps = await sdk.getPossibleSwaps(token.tokenId);
              const swapTokenIds = Object.keys(swaps);

              for (const swapTokenId of swapTokenIds) {
                const tokenY = tokenMap.get(swapTokenId);
                if (!tokenY) continue;

                const pairKey = [token.tokenId, tokenY.tokenId].sort().join("|");
                if (seenPairs.has(pairKey)) continue;
                seenPairs.add(pairKey);

                newPools.push({
                  tokenXId: token.tokenId,
                  tokenYId: tokenY.tokenId,
                  tokenXSymbol: token.symbol,
                  tokenYSymbol: tokenY.symbol,
                  tokenXContract: token.tokenContract,
                  tokenYContract: tokenY.tokenContract,
                  decimals: token.tokenDecimals,
                  feeRate: 30, // Bitflow default 0.30%
                });
              }
            } catch {
              // Token pair fetch failed — skip
            }
          })
        );
      }

      this.pools = newPools;
      this.cacheExpiry = now + this.CACHE_TTL_MS;

      logger.info("Bitflow pool cache refreshed via SDK", {
        pools: this.pools.length,
        tokens: this.tokens.length,
      });

      return this.pools;
    } catch (error: any) {
      if (error?.message?.includes("404")) {
        // Permanent failure — mark SDK as unusable so we stop retrying
        this.sdkInitFailed = true;
        logger.warn("Bitflow API returned 404 — disabling Bitflow integration for this session");
      } else {
        logger.error("Failed to fetch Bitflow pools via SDK", { error });
      }
      return this.pools;
    }
  }

  async getSwappableTokens(refresh = false): Promise<SwappableToken[]> {
    if (refresh || this.tokens.length === 0) {
      await this.getPools(refresh);
    }
    return this.tokens;
  }

  getCachedTokens(): SwappableToken[] {
    return this.tokens;
  }

  getTradingPairs(): TradingPair[] {
    return this.pools.map((p) => ({
      tokenX: p.tokenXContract ?? p.tokenXId,
      tokenY: p.tokenYContract ?? p.tokenYId,
      contractId: `${p.tokenXId}-${p.tokenYId}`,
      balanceX: 0,
      balanceY: 0,
    }));
  }

  private matchesToken(contract: string | null, symbol: string, target: string): boolean {
    const targetUpper = target.toUpperCase();
    const isTargetStx =
      targetUpper === "STX" ||
      targetUpper === "WSTX" ||
      targetUpper === "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.WSTX" ||
      targetUpper === "TOKEN-STX";

    if (isTargetStx) {
      return (
        symbol.toUpperCase() === "STX" ||
        !contract ||
        contract === "null" ||
        contract.includes(".wstx") ||
        contract.includes("wrapped-stx")
      );
    }
    if (contract) {
      if (contract === target) return true;
      if (contract.split(".").pop()?.toUpperCase() === targetUpper) return true;
    }
    return symbol.toUpperCase() === targetUpper;
  }

  findPool(tokenIn: string, tokenOut: string): LocalPool | null {
    return this.pools.find(
      (p) =>
        (this.matchesToken(p.tokenXContract, p.tokenXSymbol, tokenIn) &&
          this.matchesToken(p.tokenYContract, p.tokenYSymbol, tokenOut)) ||
        (this.matchesToken(p.tokenXContract, p.tokenXSymbol, tokenOut) &&
          this.matchesToken(p.tokenYContract, p.tokenYSymbol, tokenIn))
    ) ?? null;
  }

  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: number
  ): Promise<DEXQuote> {
    try {
      const tokenInId = this.resolveTokenId(tokenIn);
      const tokenOutId = this.resolveTokenId(tokenOut);

      if (!tokenInId || !tokenOutId) {
        const local = this.localQuote(tokenIn, tokenOut, amountIn);
        return {
          amountOut: local.amountOut,
          priceImpact: local.priceImpact,
          feeBps: 30,
          feeAmount: local.feeAmount,
        };
      }

      const sdk = this.getSDK();
      if (!sdk) {
        const local = this.localQuote(tokenIn, tokenOut, amountIn);
        return {
          amountOut: local.amountOut,
          priceImpact: local.priceImpact,
          feeBps: 30,
          feeAmount: local.feeAmount,
        };
      }

      const quote = await sdk.getQuoteForRoute(tokenInId, tokenOutId, amountIn);
      const bestRoute = quote.bestRoute ?? quote.allRoutes?.[0];
      if (!bestRoute) {
        const local = this.localQuote(tokenIn, tokenOut, amountIn);
        return {
          amountOut: local.amountOut,
          priceImpact: local.priceImpact,
          feeBps: 30,
          feeAmount: local.feeAmount,
        };
      }

      const pool = this.findPool(tokenIn, tokenOut);
      const feeBps = pool?.feeRate ?? 30;

      return {
        amountOut: bestRoute.quote ? bestRoute.quote / (10 ** (bestRoute.tokenYDecimals ?? 6)) : 0,
        priceImpact: 0,
        feeBps,
        feeAmount: amountIn * (feeBps / 10000),
      };
    } catch {
      const local = this.localQuote(tokenIn, tokenOut, amountIn);
      return {
        amountOut: local.amountOut,
        priceImpact: local.priceImpact,
        feeBps: 30,
        feeAmount: local.feeAmount,
      };
    }
  }

  async getPrice(tokenSymbol: string): Promise<number> {
    try {
      const tokenId = `token-${tokenSymbol.toLowerCase()}`;
      const sdk = this.getSDK();
      if (!sdk) return 0;

      const quote = await sdk.getQuoteForRoute(tokenId, "token-usda", 1);
      const bestRoute = quote.allRoutes?.[0] ?? quote.bestRoute;
      if (bestRoute?.quote) {
        return bestRoute.quote / (10 ** (bestRoute.tokenYDecimals ?? 6));
      }
      return 0;
    } catch {
      return 0;
    }
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    return this.getPrice(tokenSymbol);
  }

  async hasRoute(tokenIn: string, tokenOut: string): Promise<boolean> {
    await this.getPools();
    return this.findPool(tokenIn, tokenOut) !== null;
  }

  async buildSwapPayload(
    tokenIn: string,
    tokenOut: string,
    amountIn: number,
    minAmountOut: number,
    senderAddress: string
  ): Promise<TransactionPayload | null> {
    try {
      const sdk = this.getSDK();
      if (!sdk) return null;

      const tokenInId = this.resolveTokenId(tokenIn);
      const tokenOutId = this.resolveTokenId(tokenOut);
      if (!tokenInId || !tokenOutId) return null;

      const quote = await sdk.getQuoteForRoute(tokenInId, tokenOutId, amountIn);
      const bestRoute = quote.bestRoute ?? quote.allRoutes?.[0];
      if (!bestRoute) return null;

      const swapExecutionData = {
        route: bestRoute.route,
        amount: amountIn,
        tokenXDecimals: bestRoute.tokenXDecimals,
        tokenYDecimals: bestRoute.tokenYDecimals,
      };

      const slippageTolerance = Math.max(0, (amountIn - minAmountOut) / amountIn);
      const swapParams = await sdk.prepareSwap(swapExecutionData, senderAddress, slippageTolerance);
      if (!swapParams) return null;

      return {
        contractAddress: swapParams.contractAddress,
        contractName: swapParams.contractName,
        functionName: swapParams.functionName,
        functionArgs: swapParams.functionArgs,
        postConditions: swapParams.postConditions,
      };
    } catch (error) {
      logger.error("Failed to build Bitflow swap payload", { error });
      return null;
    }
  }

  // ── Helpers ──

  private resolveTokenId(contractOrSymbol: string): string | null {
    const normalized = contractOrSymbol.toUpperCase();
    if (
      normalized === "STX" ||
      normalized === "WSTX" ||
      normalized === "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.WSTX" ||
      normalized === "TOKEN-STX" ||
      normalized === "NULL"
    ) {
      return "token-stx";
    }

    const pool = this.pools.find(
      (p) =>
        this.matchesToken(p.tokenXContract, p.tokenXSymbol, contractOrSymbol) ||
        this.matchesToken(p.tokenYContract, p.tokenYSymbol, contractOrSymbol)
    );
    if (!pool) return null;

    return this.matchesToken(pool.tokenXContract, pool.tokenXSymbol, contractOrSymbol)
      ? pool.tokenXId
      : pool.tokenYId;
  }

  private localQuote(tokenIn: string, tokenOut: string, amountIn: number): { amountOut: number; priceImpact: number; feeAmount: number } {
    const pool = this.findPool(tokenIn, tokenOut);
    if (!pool) return { amountOut: 0, priceImpact: 0, feeAmount: 0 };

    const feeAmount = amountIn * (pool.feeRate / 10_000);
    const amountOut = amountIn * 0.98;
    const priceImpact = 0.5;

    return {
      amountOut: Math.round(amountOut * 1e6) / 1e6,
      priceImpact: Math.round(priceImpact * 100) / 100,
      feeAmount: Math.round(feeAmount * 1e6) / 1e6,
    };
  }
}
