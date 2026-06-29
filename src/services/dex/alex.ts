import { AlexSDK, Currency } from "alex-sdk";
import { logger } from "../../utils/logger.js";
import { RedisService } from "../redis.js";
import type { SwappableToken, SwapRoute, TransactionPayload } from "../../types.js";
import type { DEXProvider, DEXQuote } from "../../types/dexProvider.js";
import { CircuitBreakerRegistry } from "../../utils/circuitBreaker.js";

interface TokenPair {
  tokenX: string;
  tokenY: string;
  contractId: string;
  balanceX: number;
  balanceY: number;
}

export class AlexDEXService implements DEXProvider {
  name = "ALEX";
  private static instance: AlexDEXService;
  private sdk: AlexSDK;
  private swappableTokens: SwappableToken[] = [];
  private pairs: TokenPair[] = [];
  private tokensCacheExpiry: number = 0;
  private lastFetchAttemptAt: number = 0;
  private readonly TOKEN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  private readonly FETCH_COOLDOWN_MS = 5 * 60 * 1000;

  private constructor() {
    this.sdk = new AlexSDK();
  }

  private get breaker() {
    return CircuitBreakerRegistry.getBreaker("Alex");
  }

  static initialize(): AlexDEXService {
    if (!AlexDEXService.instance) {
      AlexDEXService.instance = new AlexDEXService();
    }
    return AlexDEXService.instance;
  }

  static getInstance(): AlexDEXService {
    if (!AlexDEXService.instance) {
      throw new Error("AlexDEXService not initialized. Call AlexDEXService.initialize() first.");
    }
    return AlexDEXService.instance;
  }

  async getSwappableTokens(refresh = false): Promise<SwappableToken[]> {
    const now = Date.now();
    if (!refresh && this.swappableTokens.length > 0 && now < this.tokensCacheExpiry) {
      return this.swappableTokens;
    }

    if (!refresh && now - this.lastFetchAttemptAt < this.FETCH_COOLDOWN_MS) {
      return this.swappableTokens;
    }

    this.lastFetchAttemptAt = now;
    let lastError: unknown;

    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const tokenInfos = await this.breaker.execute(() => this.sdk.fetchSwappableCurrency());

        this.swappableTokens = tokenInfos.map((t) => ({
          contractId: t.id,
          symbol: t.name,
          name: t.name,
          decimals: t.wrapTokenDecimals,
        }));

        this.tokensCacheExpiry = now + this.TOKEN_CACHE_TTL_MS;

        logger.info("Token cache refreshed via AlexSDK", {
          tokens: this.swappableTokens.length,
          attempt,
        });

        return this.swappableTokens;
      } catch (error) {
        lastError = error;
        if (attempt < 4) {
          logger.warn(`AlexSDK fetch attempt ${attempt} failed, retrying`, { error });
          await new Promise((r) => setTimeout(r, attempt * 1000));
        }
      }
    }

    logger.error("Failed to fetch tokens from AlexSDK after 4 attempts", { error: lastError });
    return this.swappableTokens;
  }

  getCachedTokens(): SwappableToken[] {
    return this.swappableTokens;
  }

  getCachedPairs(): TokenPair[] {
    return this.pairs;
  }

  getTradingPairs(): TokenPair[] {
    return this.pairs;
  }

  private getTokenDecimals(contractId: string): number {
    const token = this.swappableTokens.find(
      (t) =>
        t.contractId.toLowerCase() === contractId.toLowerCase() ||
        t.symbol.toLowerCase() === contractId.toLowerCase()
    );
    return token ? token.decimals : 6;
  }

  private resolveTokenId(symbolOrContractId: string): string {
    const token = this.swappableTokens.find(
      (t) =>
        t.contractId.toLowerCase() === symbolOrContractId.toLowerCase() ||
        t.symbol.toLowerCase() === symbolOrContractId.toLowerCase()
    );
    return token ? token.contractId : symbolOrContractId;
  }

  async hasRoute(tokenIn: string, tokenOut: string): Promise<boolean> {
    try {
      const tokenInId = this.resolveTokenId(tokenIn);
      const tokenOutId = this.resolveTokenId(tokenOut);
      const route = await this.breaker.execute(() => this.sdk.getRoute(tokenInId as Currency, tokenOutId as Currency));
      return route.length > 0;
    } catch {
      return false;
    }
  }

  findSwapRoute(tokenIn: string, tokenOut: string): SwapRoute | null {
    const route = findSwapRoute(this.pairs, tokenIn, tokenOut);
    if (!route && tokenIn !== tokenOut) {
      return { tokenIn, tokenOut, pairContract: "alex-sdk", expectedOutput: 0, priceImpact: 0 };
    }
    return route;
  }

  async getSwapAmount(
    tokenIn: string,
    tokenOut: string,
    amountIn: number
  ): Promise<{ amountOut: number; priceImpact: number }> {
    try {
      const decimalsIn = this.getTokenDecimals(tokenIn);
      const decimalsOut = this.getTokenDecimals(tokenOut);
      const amountInBigInt = BigInt(Math.floor(amountIn * (10 ** decimalsIn)));
      const tokenInId = this.resolveTokenId(tokenIn);
      const tokenOutId = this.resolveTokenId(tokenOut);
      const route = await this.breaker.execute(() => this.sdk.getRoute(tokenInId as Currency, tokenOutId as Currency));
      const amountOutBigInt = await this.breaker.execute(() => this.sdk.getAmountTo(
        tokenInId as Currency,
        amountInBigInt,
        tokenOutId as Currency,
        route.length > 0 ? route : undefined,
      ));

      const amountOut = Number(amountOutBigInt) / (10 ** decimalsOut);

      const prices = await this.breaker.execute(() => this.sdk.getLatestPrices());
      const priceIn = getPriceFromMap(prices, tokenIn);
      const priceOut = getPriceFromMap(prices, tokenOut);

      let priceImpact = 0;
      if (priceIn > 0 && priceOut > 0) {
        const spotPrice = priceIn / priceOut;
        const executionPrice = amountIn / amountOut;
        priceImpact = Math.abs(1 - executionPrice / spotPrice) * 100;
      }

      return {
        amountOut: Math.round(amountOut * (10 ** decimalsOut)) / (10 ** decimalsOut),
        priceImpact: Math.round(priceImpact * 100) / 100,
      };
    } catch {
      const fallback = calculateSwapAmount(this.pairs, tokenIn, tokenOut, amountIn);
      if (fallback.amountOut > 0) return fallback;
      return { amountOut: 0, priceImpact: 0 };
    }
  }

  calculateSwapAmount(
    tokenIn: string,
    tokenOut: string,
    amountIn: number
  ): { amountOut: number; priceImpact: number } {
    return calculateSwapAmount(this.pairs, tokenIn, tokenOut, amountIn);
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    try {
      const cacheKey = `price:${tokenSymbol.toUpperCase()}`;
      try {
        const cached = await RedisService.getInstance().get(cacheKey);
        if (cached) return parseFloat(cached);
      } catch { }

      const prices = await this.breaker.execute(() => this.sdk.getLatestPrices());
      const price = getPriceFromMap(prices, tokenSymbol);

      try {
        await RedisService.getInstance().set(cacheKey, String(price), 30);
      } catch { }

      return price;
    } catch {
      return 0;
    }
  }

  async getFeeRate(_tokenIn: string, _tokenOut: string): Promise<number> {
    try {
      const tokenInId = this.resolveTokenId(_tokenIn);
      const tokenOutId = this.resolveTokenId(_tokenOut);
      const fee = await this.breaker.execute(() => this.sdk.getFeeRate(tokenInId as Currency, tokenOutId as Currency));
      return Number(fee) / 100;
    } catch {
      return 30;
    }
  }

  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: number
  ): Promise<DEXQuote> {
    const res = await this.getSwapAmount(tokenIn, tokenOut, amountIn);
    const feeRate = await this.getFeeRate(tokenIn, tokenOut);
    return {
      amountOut: res.amountOut,
      priceImpact: res.priceImpact,
      feeBps: feeRate,
      feeAmount: amountIn * (feeRate / 10000),
    };
  }

  async buildSwapPayload(
    tokenIn: string,
    tokenOut: string,
    amountIn: number,
    minAmountOut: number,
    senderAddress: string
  ): Promise<TransactionPayload | null> {
    try {
      const tokenInId = this.resolveTokenId(tokenIn);
      const tokenOutId = this.resolveTokenId(tokenOut);
      const route = await this.breaker.execute(() => this.sdk.getRoute(tokenInId as Currency, tokenOutId as Currency));
      if (route.length === 0) return null;

      const decimalsIn = this.getTokenDecimals(tokenIn);
      const decimalsOut = this.getTokenDecimals(tokenOut);
      const amountInBigInt = BigInt(Math.floor(amountIn * (10 ** decimalsIn)));
      const minOutBigInt = BigInt(Math.floor(minAmountOut * (10 ** decimalsOut)));

      const tx = await this.breaker.execute(() => this.sdk.runSwap(
        senderAddress,
        tokenInId as Currency,
        tokenOutId as Currency,
        amountInBigInt,
        minOutBigInt,
        route,
      ));

      return {
        contractAddress: tx.contractAddress,
        contractName: tx.contractName,
        functionName: tx.functionName,
        functionArgs: tx.functionArgs as any[],
        postConditions: tx.postConditions as any[],
      };
    } catch (err) {
      logger.warn("AlexSDK buildSwapPayload failed", {
        tokenIn,
        tokenOut,
        amountIn,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async runSwap(
    senderAddress: string,
    tokenIn: string,
    tokenOut: string,
    fromAmount: number,
    minDy: number
  ): Promise<unknown> {
    const tokenInId = this.resolveTokenId(tokenIn);
    const tokenOutId = this.resolveTokenId(tokenOut);
    const decimalsIn = this.getTokenDecimals(tokenIn);
    const decimalsOut = this.getTokenDecimals(tokenOut);
    const fromAmountBigInt = BigInt(Math.floor(fromAmount * (10 ** decimalsIn)));
    const minDyBigInt = BigInt(Math.floor(minDy * (10 ** decimalsOut)));
    const route = await this.breaker.execute(() => this.sdk.getRoute(tokenInId as Currency, tokenOutId as Currency));

    return this.breaker.execute(() => this.sdk.runSwap(
      senderAddress,
      tokenInId as Currency,
      tokenOutId as Currency,
      fromAmountBigInt,
      minDyBigInt,
      route.length > 0 ? route : undefined,
    ));
  }
}

function getPriceFromMap(
  prices: Partial<Record<string, number>>,
  symbol: string
): number {
  for (const [currency, price] of Object.entries(prices)) {
    if (
      currency.toUpperCase().includes(symbol.toUpperCase()) ||
      symbol.toUpperCase().includes(currency.toUpperCase())
    ) {
      return price as number;
    }
  }
  return 0;
}

export function findSwapRoute(
  pairs: TokenPair[],
  tokenIn: string,
  tokenOut: string
): SwapRoute | null {
  if (tokenIn === tokenOut) return null;

  const direct = pairs.find(
    (p) =>
      (p.tokenX === tokenIn && p.tokenY === tokenOut) ||
      (p.tokenX === tokenOut && p.tokenY === tokenIn)
  );

  if (direct) {
    return {
      tokenIn,
      tokenOut,
      pairContract: direct.contractId,
      expectedOutput: 0,
      priceImpact: 0,
    };
  }

  for (const pair of pairs) {
    if (pair.tokenX === tokenIn || pair.tokenY === tokenIn) {
      const hopToken = pair.tokenX === tokenIn ? pair.tokenY : pair.tokenX;
      const secondHop = pairs.find(
        (p) =>
          p !== pair &&
          ((p.tokenX === hopToken && p.tokenY === tokenOut) ||
            (p.tokenY === hopToken && p.tokenX === tokenOut))
      );
      if (secondHop) {
        return {
          tokenIn,
          tokenOut,
          pairContract: `${pair.contractId}|${secondHop.contractId}`,
          expectedOutput: 0,
          priceImpact: 0,
        };
      }
    }
  }

  return null;
}

export function calculateSwapAmount(
  pairs: TokenPair[],
  tokenIn: string,
  tokenOut: string,
  amountIn: number
): { amountOut: number; priceImpact: number } {
  const pair = pairs.find(
    (p) =>
      (p.tokenX === tokenIn && p.tokenY === tokenOut) ||
      (p.tokenX === tokenOut && p.tokenY === tokenIn)
  );

  if (!pair) {
    return { amountOut: 0, priceImpact: 0 };
  }

  const isXY = pair.tokenX === tokenIn;
  const reserveIn = isXY ? pair.balanceX : pair.balanceY;
  const reserveOut = isXY ? pair.balanceY : pair.balanceX;

  if (reserveIn <= 0 || reserveOut <= 0) {
    return { amountOut: 0, priceImpact: 0 };
  }

  const amountInWithFee = amountIn * 0.997;
  const amountOut =
    (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);
  const spotPrice = reserveOut / reserveIn;
  const executionPrice = amountOut / amountIn;
  const priceImpact = Math.abs(1 - executionPrice / spotPrice) * 100;

  return {
    amountOut: Math.round(amountOut * 1e6) / 1e6,
    priceImpact: Math.round(priceImpact * 100) / 100,
  };
}
