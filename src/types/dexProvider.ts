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
