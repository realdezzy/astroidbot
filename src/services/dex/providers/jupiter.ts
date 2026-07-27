import { logger } from "../../../utils/logger.js";
import { toDecimalString } from "../../../utils/decimal.js";
import { BaseDEXProvider } from "./baseDexProvider.js";
import { CircuitBreakerRegistry } from "../../../utils/circuitBreaker.js";
import { requireSvmConfig, type ChainDescriptor } from "../../../types/chain.js";
import type { SwappableToken, TransactionPayload } from "../../../types.js";
import type { DEXQuote } from "../../../types/dexProvider.js";

/** Well-known Solana mints. Jupiter's token list is huge and mostly noise, so
 *  the curated set covers what the trading flows actually reference; any other
 *  mint address still resolves by being passed through directly. */
const CURATED_TOKENS: Record<string, { mint: string; decimals: number; name: string }> = {
  SOL: { mint: "So11111111111111111111111111111111111111112", decimals: 9, name: "Wrapped SOL" },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, name: "USD Coin" },
  USDT: { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, name: "Tether USD" },
  JUP: { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", decimals: 6, name: "Jupiter" },
  BONK: { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", decimals: 5, name: "Bonk" },
};

interface JupiterQuoteResponse {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan?: { swapInfo?: { feeAmount?: string } }[];
}

/**
 * Jupiter — Solana's routing aggregator, and the first SVM DEXProvider.
 *
 * Unlike a Uniswap-style provider, Jupiter returns a complete, already-built
 * transaction rather than a call list. buildSwapPayload therefore emits an
 * `svm` payload carrying that serialized transaction, and SolanaAdapter's job
 * is to refresh the blockhash, sign and send. Taking the transaction apart to
 * force it into the EVM call-list shape would gain nothing.
 */
export class JupiterProvider extends BaseDEXProvider {
  readonly name: string;
  private readonly apiUrl: string;

  constructor(descriptor: ChainDescriptor) {
    super(descriptor);
    const svm = requireSvmConfig(descriptor);
    if (!svm.jupiterApiUrl) {
      throw new Error(`Chain ${descriptor.chainId} has no Jupiter API configured`);
    }
    this.apiUrl = svm.jupiterApiUrl.replace(/\/$/, "");
    // Per-chain name so the registry can hold providers for mainnet and any
    // other SVM network simultaneously — a shared name would silently drop one.
    this.name = `Jupiter-${descriptor.chainId}`;
  }

  private get breaker() {
    return CircuitBreakerRegistry.getBreaker(this.name);
  }

  private tokenList(): SwappableToken[] {
    return Object.entries(CURATED_TOKENS).map(([symbol, t]) => ({
      contractId: t.mint,
      symbol,
      name: t.name,
      decimals: t.decimals,
      chainFamily: this.descriptor.family,
      chainId: this.descriptor.chainId,
    }));
  }

  async getSwappableTokens(_refresh = false): Promise<SwappableToken[]> {
    return this.tokenList();
  }

  getCachedTokens(): SwappableToken[] {
    return this.tokenList();
  }

  private resolveToken(symbolOrMint: string): SwappableToken | null {
    const needle = symbolOrMint.toUpperCase();
    const curated = CURATED_TOKENS[needle];
    if (curated) {
      return {
        contractId: curated.mint,
        symbol: needle,
        name: curated.name,
        decimals: curated.decimals,
        chainFamily: this.descriptor.family,
        chainId: this.descriptor.chainId,
      };
    }

    // A raw mint address: base58, 32-44 chars. Decimals default to 9 (SOL's),
    // which is wrong for many SPL tokens — so an unknown mint is usable but
    // its amounts should not be trusted for sizing without a decimals lookup.
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(symbolOrMint)) {
      return {
        contractId: symbolOrMint,
        symbol: symbolOrMint,
        name: symbolOrMint,
        decimals: this.descriptor.nativeDecimals,
        chainFamily: this.descriptor.family,
        chainId: this.descriptor.chainId,
      };
    }
    return null;
  }

  private async fetchQuote(
    tokenIn: SwappableToken,
    tokenOut: SwappableToken,
    rawAmount: bigint,
    slippageBps = 50
  ): Promise<JupiterQuoteResponse | null> {
    const params = new URLSearchParams({
      inputMint: tokenIn.contractId,
      outputMint: tokenOut.contractId,
      amount: rawAmount.toString(),
      slippageBps: String(slippageBps),
    });

    const response = await this.breaker.execute(() =>
      fetch(`${this.apiUrl}/quote?${params}`)
    );

    if (!response.ok) return null;
    return (await response.json()) as JupiterQuoteResponse;
  }

  /** Converts a decimal amount to the token's smallest unit without float error. */
  private toRaw(amount: number, decimals: number): bigint {
    const [whole = "0", frac = ""] = toDecimalString(amount).split(".");
    const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
    return BigInt(whole + padded);
  }

  private fromRaw(raw: string, decimals: number): number {
    return Number(raw) / 10 ** decimals;
  }

  async hasRoute(tokenIn: string, tokenOut: string): Promise<boolean> {
    const tIn = this.resolveToken(tokenIn);
    const tOut = this.resolveToken(tokenOut);
    if (!tIn || !tOut || tIn.contractId === tOut.contractId) return false;

    try {
      const quote = await this.fetchQuote(tIn, tOut, this.toRaw(1, tIn.decimals));
      return quote !== null && BigInt(quote.outAmount) > 0n;
    } catch {
      return false;
    }
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    const token = this.resolveToken(tokenSymbol);
    const stable = this.resolveToken(this.descriptor.stableSymbol);
    if (!token || !stable) return 0;
    if (token.contractId === stable.contractId) return 1;

    const cached = this.cachedPrice(token.contractId);
    if (cached !== undefined) return cached;

    try {
      const quote = await this.fetchQuote(token, stable, this.toRaw(1, token.decimals));
      if (!quote) return 0;
      return this.cachePrice(token.contractId, this.fromRaw(quote.outAmount, stable.decimals));
    } catch {
      return 0;
    }
  }

  async getQuote(tokenIn: string, tokenOut: string, amountIn: number): Promise<DEXQuote> {
    const tIn = this.resolveToken(tokenIn);
    const tOut = this.resolveToken(tokenOut);
    if (!tIn || !tOut || amountIn <= 0) {
      return { amountOut: 0, priceImpact: 0, feeBps: 0, feeAmount: 0 };
    }

    try {
      const quote = await this.fetchQuote(tIn, tOut, this.toRaw(amountIn, tIn.decimals));
      if (!quote) return { amountOut: 0, priceImpact: 0, feeBps: 0, feeAmount: 0 };

      const amountOut = this.fromRaw(quote.outAmount, tOut.decimals);
      // Jupiter reports impact as a fraction ("0.0031"); the DEXQuote contract
      // is a percentage.
      const priceImpact = Math.abs(parseFloat(quote.priceImpactPct ?? "0")) * 100;

      const feeRaw = (quote.routePlan ?? []).reduce(
        (sum, hop) => sum + BigInt(hop.swapInfo?.feeAmount ?? "0"),
        0n
      );
      const feeAmount = this.fromRaw(feeRaw.toString(), tIn.decimals);
      const feeBps = amountIn > 0 ? (feeAmount / amountIn) * 10_000 : 0;

      return {
        amountOut,
        priceImpact: Math.round(priceImpact * 100) / 100,
        feeBps: Math.round(feeBps),
        feeAmount,
      };
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
    const tIn = this.resolveToken(tokenIn);
    const tOut = this.resolveToken(tokenOut);
    if (!tIn || !tOut) return null;

    try {
      const rawIn = this.toRaw(amountIn, tIn.decimals);
      const quote = await this.fetchQuote(tIn, tOut, rawIn);
      if (!quote) return null;

      // Enforce the caller's slippage bound ourselves rather than trusting the
      // quote's own: minAmountOut is what RiskManager approved.
      const expectedOut = this.fromRaw(quote.outAmount, tOut.decimals);
      if (minAmountOut > 0 && expectedOut < minAmountOut) {
        logger.warn(`${this.name} route worse than the approved minimum`, {
          expectedOut,
          minAmountOut,
        });
        return null;
      }

      const response = await this.breaker.execute(() =>
        fetch(`${this.apiUrl}/swap`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: senderAddress,
            // Jupiter handles the wrapped-SOL account lifecycle when asked,
            // which removes an entire class of leftover-account bugs.
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
          }),
        })
      );

      if (!response.ok) {
        logger.warn(`${this.name} swap build failed`, { status: response.status });
        return null;
      }

      const { swapTransaction } = (await response.json()) as { swapTransaction?: string };
      if (!swapTransaction) return null;

      return { kind: "svm", swapTransaction };
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
