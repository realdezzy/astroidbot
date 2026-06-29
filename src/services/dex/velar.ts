import { VelarSDK, getTokensMeta } from "@velarprotocol/velar-sdk";
import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { RedisService } from "../redis.js";
import type { SwappableToken, TransactionPayload } from "../../types.js";
import type { DEXProvider, DEXQuote } from "../../types/dexProvider.js";
import { CircuitBreakerRegistry } from "../../utils/circuitBreaker.js";

export class VelarDEXService implements DEXProvider {
  name = "Velar";
  private static instance: VelarDEXService;
  private sdk: VelarSDK;
  private initialized = false;
  private swappableTokens: SwappableToken[] = [];
  private tokensCacheExpiry: number = 0;
  private lastFetchAttemptAt: number = 0;
  private readonly TOKEN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  private readonly FETCH_COOLDOWN_MS = 5 * 60 * 1000;

  private constructor() {
    this.sdk = new VelarSDK({ headless: true });
  }

  private get breaker() {
    return CircuitBreakerRegistry.getBreaker("Velar");
  }

  static initialize(): VelarDEXService {
    if (!VelarDEXService.instance) {
      VelarDEXService.instance = new VelarDEXService();
    }
    return VelarDEXService.instance;
  }

  static getInstance(): VelarDEXService {
    if (!VelarDEXService.instance) {
      throw new Error("VelarDEXService not initialized. Call VelarDEXService.initialize() first.");
    }
    return VelarDEXService.instance;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const config = ConfigManager.getInstance().config;
    this.sdk.setBlockChainApiUrl(config.STACKS_API_URL);
    await this.breaker.execute(() => this.sdk.init());
    this.initialized = true;
  }

  private resolveTokenId(symbolOrContractId: string): string | null {
    const token = this.swappableTokens.find(
      (t) =>
        t.contractId.toLowerCase() === symbolOrContractId.toLowerCase() ||
        t.symbol.toLowerCase() === symbolOrContractId.toLowerCase()
    );
    if (token) return token.contractId;
    // Only accept raw values that look like a valid Stacks contract ID (addr.name)
    if (symbolOrContractId.includes(".")) return symbolOrContractId;
    return null;
  }

  private getTokenDecimals(symbolOrContractId: string): number {
    const token = this.swappableTokens.find(
      (t) =>
        t.contractId.toLowerCase() === symbolOrContractId.toLowerCase() ||
        t.symbol.toLowerCase() === symbolOrContractId.toLowerCase()
    );
    return token ? token.decimals : 6;
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
    try {
      await this.ensureInitialized();
      const tokensMeta = await this.breaker.execute(() => getTokensMeta());
      this.swappableTokens = tokensMeta.map((t: any) => ({
        contractId: t.contractAddress,
        symbol: t.symbol,
        name: t.name,
        decimals: Math.round(Math.log10(t.tokenDecimalNum)) || 6,
      }));
      this.tokensCacheExpiry = now + this.TOKEN_CACHE_TTL_MS;
      logger.info(`VelarProvider: cache updated with ${this.swappableTokens.length} tokens`);
    } catch (err) {
      logger.warn("VelarProvider getSwappableTokens failed, using cached list", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return this.swappableTokens;
  }

  async hasRoute(tokenIn: string, tokenOut: string): Promise<boolean> {
    try {
      await this.ensureInitialized();
      const tokenInId = this.resolveTokenId(tokenIn);
      const tokenOutId = this.resolveTokenId(tokenOut);
      if (!tokenInId || !tokenOutId) return false;
      const swap = await this.breaker.execute(() => this.sdk.getSwapInstance({
        account: "SPMYF9RSJWA9SGDM25ARH13C3HSEM93EWDPE07J2",
        inToken: tokenInId,
        outToken: tokenOutId,
      }));
      const info = await this.breaker.execute(() => swap.buildPoolInfo());
      return !!(info && info.routes && info.routes.length > 0);
    } catch {
      return false;
    }
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    try {
      await this.ensureInitialized();
      const token = this.swappableTokens.find(
        (t) =>
          t.symbol.toLowerCase() === tokenSymbol.toLowerCase() ||
          t.contractId.toLowerCase() === tokenSymbol.toLowerCase()
      );
      if (!token) return 0;

      const cacheKey = `velar:price:${token.symbol.toUpperCase()}`;
      try {
        const cached = await RedisService.getInstance().get(cacheKey);
        if (cached) return parseFloat(cached);
      } catch {}

      const tokensMeta = await this.breaker.execute(() => getTokensMeta());
      const match = tokensMeta.find((t: any) => t.symbol.toLowerCase() === token.symbol.toLowerCase());
      const price = match ? parseFloat(match.price) : 0;

      try {
        await RedisService.getInstance().set(cacheKey, String(price), 30);
      } catch {}
      return price;
    } catch {
      return 0;
    }
  }

  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: number
  ): Promise<DEXQuote> {
    try {
      await this.ensureInitialized();
      const tokenInId = this.resolveTokenId(tokenIn);
      const tokenOutId = this.resolveTokenId(tokenOut);

      if (!tokenInId || !tokenOutId) {
        return { amountOut: 0, priceImpact: 0, feeBps: 30, feeAmount: 0 };
      }

      const swap = await this.breaker.execute(() => this.sdk.getSwapInstance({
        account: "SPMYF9RSJWA9SGDM25ARH13C3HSEM93EWDPE07J2",
        inToken: tokenInId,
        outToken: tokenOutId,
      }));

      const quote = await this.breaker.execute(() => swap.getComputedAmount({
        amount: amountIn,
      }));

      if (!quote || !quote.valid) {
        throw new Error(quote?.errorMessage || "Invalid quote from Velar");
      }

      const amountOut = Number(quote.value);

      const priceIn = await this.getTokenPrice(tokenIn);
      const priceOut = await this.getTokenPrice(tokenOut);
      let priceImpact = 0;
      if (priceIn > 0 && priceOut > 0) {
        const spotPrice = priceIn / priceOut;
        const executionPrice = amountIn / amountOut;
        priceImpact = Math.abs(1 - executionPrice / spotPrice) * 100;
      }

      return {
        amountOut,
        priceImpact: Math.round(priceImpact * 100) / 100,
        feeBps: 30,
        feeAmount: amountIn * 0.003,
      };
    } catch (err) {
      logger.warn("VelarProvider getQuote failed", {
        tokenIn,
        tokenOut,
        amountIn,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        amountOut: 0,
        priceImpact: 0,
        feeBps: 30,
        feeAmount: 0,
      };
    }
  }

  async buildSwapPayload(
    tokenIn: string,
    tokenOut: string,
    amountIn: number,
    minAmountOut: number,
    senderAddress: string
  ): Promise<TransactionPayload | null> {
    try {
      await this.ensureInitialized();
      const tokenInId = this.resolveTokenId(tokenIn);
      const tokenOutId = this.resolveTokenId(tokenOut);

      if (!tokenInId || !tokenOutId) return null;

      const swap = await this.breaker.execute(() => this.sdk.getSwapInstance({
        account: senderAddress,
        inToken: tokenInId,
        outToken: tokenOutId,
      }));

      const quote = await this.breaker.execute(() => swap.getComputedAmount({ amount: amountIn }));
      const expectedOut = Number(quote.value) || minAmountOut;
      let slippagePct = 1.0;
      if (expectedOut > 0 && minAmountOut > 0) {
        slippagePct = Math.max(0.5, Math.round((1 - minAmountOut / expectedOut) * 100 * 100) / 100);
      }

      const tx = await this.breaker.execute(() => swap.swap({
        amount: amountIn,
        slippage: slippagePct,
      }));

      return {
        contractAddress: tx.contractAddress,
        contractName: tx.contractName,
        functionName: tx.functionName,
        functionArgs: tx.functionArgs as any[],
        postConditions: tx.postConditions as any[],
      };
    } catch (err) {
      logger.warn("VelarProvider buildSwapPayload failed", {
        tokenIn,
        tokenOut,
        amountIn,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
