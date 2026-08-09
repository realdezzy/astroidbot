import type { SwappableToken, TransactionPayload } from "../types.js";

export interface DEXQuote {
  amountOut: number;
  priceImpact: number;
  feeBps: number;
  feeAmount: number;
}

export interface TradingPair {
  tokenX: string;
  tokenY: string;
  contractId: string;
  balanceX: number;
  balanceY: number;
}

export interface DEXProvider {
  name: string;
  // Undeclared == "stacks" (every provider written before multi-chain support
  // existed is a Stacks DEX) — new chains' providers must declare this.
  chainFamily?: string;
  // The specific network this provider routes on ("base:mainnet",
  // "celo:mainnet"). Scoping by family alone is not enough: every EVM DEX on
  // every EVM chain shares the family "evm", so a Base wallet would otherwise
  // be offered Celo quotes and handed a router address that doesn't exist on
  // its chain. Undeclared falls back to the family's default network.
  chainId?: string;
  getSwappableTokens(refresh?: boolean): Promise<SwappableToken[]>;
  hasRoute(tokenIn: string, tokenOut: string): Promise<boolean>;
  getQuote(tokenIn: string, tokenOut: string, amountIn: number): Promise<DEXQuote>;
  getTokenPrice(tokenSymbol: string): Promise<number>;
  buildSwapPayload(
    tokenIn: string,
    tokenOut: string,
    amountIn: number,
    minAmountOut: number,
    senderAddress: string
  ): Promise<TransactionPayload | null>;
  // Optional: providers may expose a synchronous cached token list and LP pair metadata
  getCachedTokens?(): SwappableToken[];
  getTradingPairs?(): TradingPair[];
}
