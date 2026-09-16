import { logger } from "../../../utils/logger.js";
import { toDecimalString } from "../../../utils/decimal.js";
import { BaseDEXProvider } from "./baseDexProvider.js";
import { CircuitBreakerRegistry } from "../../../utils/circuitBreaker.js";
import { ConfigManager } from "../../../config.js";
import { rpcUrlOverride } from "../../chains/evm/evmClient.js";
import { requireSvmConfig, type ChainDescriptor } from "../../../types/chain.js";
import { stocksForChain } from "../../stocks/stockRegistry.js";
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
  private readonly apiKey: string | undefined;
  private readonly rpcUrl: string;
  /**
   * Mint -> decimals, or null for "asked and could not read it".
   *
   * Cached for the life of the process because an SPL mint's decimals are
   * fixed at initialisation and cannot change — the same reasoning as the
   * permanent ERC-20 decimals cache on the EVM side.
   */
  private readonly decimalsCache = new Map<string, number | null>();

  constructor(descriptor: ChainDescriptor) {
    super(descriptor);
    const svm = requireSvmConfig(descriptor);
    if (!svm.jupiterApiUrl) {
      throw new Error(`Chain ${descriptor.chainId} has no Jupiter API configured`);
    }
    // The keyed host is the same surface as the free one, so a key swaps the
    // host rather than changing any call. Without it, lite-api rate-limits per
    // IP — fine for one deployment, not for one quoting for many users.
    const apiKey = ConfigManager.getInstance().config.JUPITER_API_KEY;
    this.apiKey = apiKey;
    this.apiUrl = (apiKey
      ? svm.jupiterApiUrl.replace("lite-api.jup.ag", "api.jup.ag")
      : svm.jupiterApiUrl
    ).replace(/\/$/, "");
    // Per-chain name so the registry can hold providers for mainnet and any
    // other SVM network simultaneously — a shared name would silently drop one.
    this.name = `Jupiter-${descriptor.chainId}`;
    this.rpcUrl = rpcUrlOverride(descriptor.chainId, svm.defaultRpcUrl);
  }

  private get breaker() {
    return CircuitBreakerRegistry.getBreaker(this.name);
  }

  private tokenList(): SwappableToken[] {
    return [
      ...Object.entries(CURATED_TOKENS).map(([symbol, t]) => ({
        contractId: t.mint,
        symbol,
        name: t.name,
        decimals: t.decimals,
        chainFamily: this.descriptor.family,
        chainId: this.descriptor.chainId,
      })),
      // Curated tokenized stocks (Ondo's `NVDAon` etc.). Listing them here is
      // what makes the catalogue treat them as routable, so discovery gets a
      // live Jupiter price instead of only identity.
      ...stocksForChain(this.descriptor.chainId).map((s) => ({
        contractId: s.contractId,
        symbol: s.symbol,
        name: s.name,
        decimals: s.decimals,
        chainFamily: this.descriptor.family,
        chainId: this.descriptor.chainId,
      })),
    ];
  }

  async getSwappableTokens(_refresh = false): Promise<SwappableToken[]> {
    return this.tokenList();
  }

  getCachedTokens(): SwappableToken[] {
    return this.tokenList();
  }

  private async resolveToken(symbolOrMint: string): Promise<SwappableToken | null> {
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

    // A curated tokenized stock, by symbol (`NVDAon`) or by its exact mint.
    // Exact, not lowercased — base58 is case-sensitive.
    const stock = stocksForChain(this.descriptor.chainId).find(
      (s) => s.symbol.toUpperCase() === needle || s.contractId === symbolOrMint
    );
    if (stock) {
      return {
        contractId: stock.contractId,
        symbol: stock.symbol,
        name: stock.name,
        decimals: stock.decimals,
        chainFamily: this.descriptor.family,
        chainId: this.descriptor.chainId,
      };
    }

    // A raw mint address: base58, 32-44 chars.
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(symbolOrMint)) return null;

    // Decimals used to default to the descriptor's native 9, which is wrong
    // for most SPL tokens — USDC and USDT are both 6, BONK is 5. That number
    // is not advisory: it reaches `toRaw()` in buildSwapPayload and scales the
    // amount actually spent, so treating a 6-decimal mint as 9-decimal asks to
    // move a thousand times more than the user typed. Discovery puts a Trade
    // button next to arbitrary mints, so this is the normal path, not an edge.
    const decimals = await this.mintDecimals(symbolOrMint);
    if (decimals === null) return null;

    return {
      contractId: symbolOrMint,
      symbol: symbolOrMint,
      name: symbolOrMint,
      decimals,
      chainFamily: this.descriptor.family,
      chainId: this.descriptor.chainId,
    };
  }

  /**
   * Decimals straight from the SPL mint account, or null if unreadable.
   *
   * Null fails the resolve, which surfaces as "no route" — a cheap and visible
   * failure. A wrong scale factor is neither.
   */
  private async mintDecimals(mint: string): Promise<number | null> {
    const cached = this.decimalsCache.get(mint);
    if (cached !== undefined) return cached;

    let decimals: number | null = null;
    try {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [mint, { encoding: "jsonParsed" }],
        }),
      });

      if (response.ok) {
        const body = (await response.json()) as {
          result?: { value?: { data?: { parsed?: { info?: { decimals?: number } } } } };
        };
        const value = body.result?.value?.data?.parsed?.info?.decimals;
        if (typeof value === "number") decimals = value;
      }
    } catch {
      // Left null; the caller declines to resolve.
    }

    if (decimals === null) {
      logger.warn("[jupiter] could not read mint decimals; refusing to resolve", {
        chainId: this.descriptor.chainId,
        mint,
      });
    }

    this.decimalsCache.set(mint, decimals);
    return decimals;
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
      fetch(`${this.apiUrl}/quote?${params}`, { headers: this.headers() })
    );

    if (!response.ok) return null;
    return (await response.json()) as JupiterQuoteResponse;
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { "x-api-key": this.apiKey } : {};
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
    const [tIn, tOut] = await Promise.all([
      this.resolveToken(tokenIn),
      this.resolveToken(tokenOut),
    ]);
    if (!tIn || !tOut || tIn.contractId === tOut.contractId) return false;

    try {
      const quote = await this.fetchQuote(tIn, tOut, this.toRaw(1, tIn.decimals));
      return quote !== null && BigInt(quote.outAmount) > 0n;
    } catch {
      return false;
    }
  }

  async getTokenPrice(tokenSymbol: string): Promise<number | null> {
    const [token, stable] = await Promise.all([
      this.resolveToken(tokenSymbol),
      this.resolveToken(this.descriptor.stableSymbol),
    ]);
    if (!token || !stable) return null;
    if (token.contractId === stable.contractId) return 1;

    const cached = this.cachedPrice(token.contractId);
    if (cached !== undefined) return cached;

    try {
      const quote = await this.fetchQuote(token, stable, this.toRaw(1, token.decimals));
      if (!quote) return null;
      return this.cachePrice(token.contractId, this.fromRaw(quote.outAmount, stable.decimals));
    } catch {
      return null;
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
    const [tIn, tOut] = await Promise.all([
      this.resolveToken(tokenIn),
      this.resolveToken(tokenOut),
    ]);
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
          headers: { "Content-Type": "application/json", ...this.headers() },
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
