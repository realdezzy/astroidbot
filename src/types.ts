export interface SwappableToken {
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
  supportedBy?: string[];
}

export interface PortfolioTarget {
  token: string;
  targetWeight: number;
}

export interface RebalanceAction {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  direction: "BUY" | "SELL";
  reason: string;
}

export interface GridSpreadConfig {
  tokenPair: string;
  midPrice: number;
  levels: number;
  spreadBps: number;
}

export enum BotStatus {
  IDLE = "IDLE",
  RUNNING = "RUNNING",
  HALTED = "HALTED",
  ERROR = "ERROR",
}

export interface BotState {
  status: BotStatus;
  lastCycle: Date | null;
  dailyPnl: number;
  haltedReason: string | null;
}

export interface TokenBalance {
  token: string;
  symbol: string;
  balance: number;
  usdValue: number;
}

export interface SwapRoute {
  tokenIn: string;
  tokenOut: string;
  pairContract: string;
  expectedOutput: number;
  priceImpact: number;
}

export interface TransactionPayload {
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: any[];
  postConditions: any[];
}

export interface AISentimentResult {
  overallSentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: number;
  reasoning: string;
  timestamp: Date;
}

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}
