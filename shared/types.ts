export type TradeDirection = "BUY" | "SELL";
export type BotStatus = "RUNNING" | "HALTED" | "IDLE";
export type AiMode = "off" | "advisor" | "autonomous";
export type AIProvider = "openai" | "deepseek" | "google";
export type AIAction = "trade" | "info" | "settings" | "halt" | "resume" | "create_strategy" | "chat" | "unknown";
export type AIContext = "sentiment" | "portfolio" | "market_making" | "parse_command";

export type StrategyType =
  | "portfolio_rebalance" | "grid" | "dca" | "sniper" | "copy"
  | "momentum" | "mean_reversion" | "twap" | "stop_loss_tp" | "rotational" | "breakout";

export interface PortfolioTarget {
  token: string;
  targetWeight: number;
}

export interface GridSpreadConfig {
  tokenPair: string;
  midPrice: number;
  levels: number;
  spreadBps: number;
}

export interface RebalanceAction {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  direction: "BUY" | "SELL";
  reason: string;
}

export interface TokenBalance {
  token: string;
  symbol: string;
  balance: number;
  usdValue: number;
}

export interface AISentimentResult {
  overallSentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: number;
  reasoning: string;
  timestamp: Date;
}

export interface TransactionPayload {
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: any[];
  postConditions: any[];
}

export interface SwappableToken {
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface FieldDef {
  key: string;
  label: string;
  type: "number" | "text";
  placeholder?: string;
  step?: string;
}

export interface StrategyDef {
  type: StrategyType;
  label: string;
  desc: string;
  defaults: Record<string, unknown>;
  fields: FieldDef[];
}

export interface NavItem {
  to: string;
  label: string;
  iconKey: string;
}
