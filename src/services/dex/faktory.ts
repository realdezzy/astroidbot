import { FaktorySDK } from "@faktoryfun/core-sdk";
import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";
import type { SwappableToken, TransactionPayload } from "../../types.js";
import type { DEXProvider, DEXQuote } from "../../types/dexProvider.js";

export class FaktoryDEXService implements DEXProvider {
  name = "Faktory";
  private static instance: FaktoryDEXService;
  private sdk: FaktorySDK;
  private initialized = false;
  private swappableTokens: SwappableToken[] = [];
  private tokensCacheExpiry: number = 0;
  private lastFetchAttemptAt: number = 0;
  private readonly TOKEN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  private readonly FETCH_COOLDOWN_MS = 5 * 60 * 1000;

  private constructor() {
    // We instantiate lazily inside ensureInitialized to pass proper network
    this.sdk = null as any;
  }

  static initialize(): FaktoryDEXService {
    if (!FaktoryDEXService.instance) {
      FaktoryDEXService.instance = new FaktoryDEXService();
    }
    return FaktoryDEXService.instance;
  }

  static getInstance(): FaktoryDEXService {
    if (!FaktoryDEXService.instance) {
      throw new Error("FaktoryDEXService not initialized. Call FaktoryDEXService.initialize() first.");
    }
    return FaktoryDEXService.instance;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const config = ConfigManager.getInstance().config;
    
    // Map bot network config to FaktorySDK expected values ('mainnet' | 'testnet')
    const stacksApiUrl = config.STACKS_API_URL.toLowerCase();
    const network = (stacksApiUrl.includes("testnet") || stacksApiUrl.includes("sandbox"))
      ? "testnet"
      : "mainnet";

    this.sdk = new FaktorySDK({
      network,
      apiHost: network === "testnet" ? "https://faktory-testnet-be.vercel.app/api" : "https://faktory-be.vercel.app/api",
    });
    this.initialized = true;
  }

  private isStx(token: string): boolean {
    const t = token.toLowerCase();
    return (
      t === "stx" ||
      t === "token-stx" ||
      t === "sp1y5ystahz88xyk1vpdh24gy0hpx5j4jectmy4a1.wstx" ||
      t === "sp1y5ystahz88xyk1vpdh24gy0hpx5j4jectmy4a1.wstx-token"
    );
  }

  private async getOrFetchToken(tokenContractId: string): Promise<any | null> {
    let token = this.swappableTokens.find(
      (t) =>
        t.contractId.toLowerCase() === tokenContractId.toLowerCase() ||
        t.symbol.toLowerCase() === tokenContractId.toLowerCase()
    );
    if (token) return token;

    try {
      const results = await this.sdk.getVerifiedTokens({ search: tokenContractId });
      const found = results.results.find(
        (t) =>
          t.tokenContract.toLowerCase() === tokenContractId.toLowerCase() ||
          t.symbol.toLowerCase() === tokenContractId.toLowerCase()
      );
      if (found) {
        const swappable = {
          contractId: found.tokenContract,
          symbol: found.symbol,
          name: found.name,
          decimals: found.decimals || 6,
          dexContract: found.dexContract,
        };
        this.swappableTokens.push(swappable);
        return swappable;
      }
    } catch (err) {
      logger.warn("FaktoryProvider dynamic token fetch failed", { tokenContractId, error: err });
    }
    return null;
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
      const verified = await this.sdk.getVerifiedTokens({ limit: 200 });
      this.swappableTokens = verified.results.map((t: any) => ({
        contractId: t.tokenContract,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals || 6,
        dexContract: t.dexContract,
      }));
      this.tokensCacheExpiry = now + this.TOKEN_CACHE_TTL_MS;
      logger.info(`FaktoryProvider: cache updated with ${this.swappableTokens.length} tokens`);
    } catch (err) {
      logger.warn("FaktoryProvider getSwappableTokens failed, using cached list", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return this.swappableTokens;
  }

  async hasRoute(tokenIn: string, tokenOut: string): Promise<boolean> {
    try {
      await this.ensureInitialized();
      const inIsStx = this.isStx(tokenIn);
      const outIsStx = this.isStx(tokenOut);

      if (inIsStx && outIsStx) return false;
      if (!inIsStx && !outIsStx) return false;

      const nonStxToken = inIsStx ? tokenOut : tokenIn;
      const token = await this.getOrFetchToken(nonStxToken);
      return !!token;
    } catch {
      return false;
    }
  }

  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: number
  ): Promise<DEXQuote> {
    try {
      await this.ensureInitialized();
      const inIsStx = this.isStx(tokenIn);
      const outIsStx = this.isStx(tokenOut);

      if (inIsStx && outIsStx) throw new Error("Cannot swap STX to STX");
      if (!inIsStx && !outIsStx) throw new Error("Direct token-to-token swaps not supported on Faktory");

      const nonStxToken = inIsStx ? tokenOut : tokenIn;
      const token = await this.getOrFetchToken(nonStxToken);
      if (!token) throw new Error(`Token ${nonStxToken} not found on Faktory`);

      const dummySender = "SPMYF9RSJWA9SGDM25ARH13C3HSEM93EWDPE07J2";

      let amountOut = 0;
      if (inIsStx) {
        const quote = await this.sdk.getIn(token.dexContract, dummySender, amountIn);
        const [_, contractName] = token.dexContract.split(".");
        const isExternal = !contractName.endsWith("faktory-dex");

        let quoteAmountStr = "";
        if (isExternal) {
          quoteAmountStr = (quote as any).value.value["buyable-token"]?.value || "0";
        } else {
          quoteAmountStr = (quote as any).value.value["tokens-out"]?.value || "0";
        }
        amountOut = Number(quoteAmountStr) / (10 ** token.decimals);
      } else {
        const quote = await this.sdk.getOut(token.dexContract, dummySender, amountIn);
        const quoteAmountStr = (quote as any).value.value["stx-out"]?.value || "0";
        amountOut = Number(quoteAmountStr) / 1000000;
      }

      const feeBps = 50;
      let priceImpact = 0;
      try {
        const tokenDetails = await this.sdk.getToken(token.dexContract);
        const spotPrice = tokenDetails.data.price;
        if (spotPrice > 0) {
          const executionPrice = inIsStx ? (amountIn / amountOut) : (amountOut / amountIn);
          priceImpact = Math.abs(1 - executionPrice / spotPrice) * 100;
        }
      } catch {}

      return {
        amountOut,
        priceImpact: Math.round(priceImpact * 100) / 100,
        feeBps,
        feeAmount: amountIn * (feeBps / 10000),
      };
    } catch (err) {
      logger.warn("FaktoryProvider getQuote failed", {
        tokenIn,
        tokenOut,
        amountIn,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        amountOut: 0,
        priceImpact: 0,
        feeBps: 50,
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
      const inIsStx = this.isStx(tokenIn);
      const nonStxToken = inIsStx ? tokenOut : tokenIn;
      const token = await this.getOrFetchToken(nonStxToken);
      if (!token) throw new Error(`Token ${nonStxToken} not found on Faktory`);

      const slippage = 15;

      let tx: any;
      if (inIsStx) {
        tx = await this.sdk.getBuyParams({
          dexContract: token.dexContract,
          inAmount: amountIn,
          senderAddress,
          slippage,
        });
      } else {
        tx = await this.sdk.getSellParams({
          dexContract: token.dexContract,
          amount: amountIn,
          senderAddress,
          slippage,
        });
      }

      return {
        contractAddress: tx.contractAddress,
        contractName: tx.contractName,
        functionName: tx.functionName,
        functionArgs: tx.functionArgs as any[],
        postConditions: tx.postConditions as any[],
      };
    } catch (err) {
      logger.warn("FaktoryProvider buildSwapPayload failed", {
        tokenIn,
        tokenOut,
        amountIn,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    try {
      await this.ensureInitialized();
      if (this.isStx(tokenSymbol)) return 1.0;
      const token = await this.getOrFetchToken(tokenSymbol);
      if (!token) return 0;
      const tokenDetails = await this.sdk.getToken(token.dexContract);
      return tokenDetails.data.price || 0;
    } catch {
      return 0;
    }
  }
}
