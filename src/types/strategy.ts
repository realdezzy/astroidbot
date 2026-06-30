import type { TokenBalance, SwappableToken, RebalanceAction, PortfolioTarget } from "../types.js";

export interface TradeSettings {
  slippageBps: number;
  maxPositionPct: number;
  dailyLossLimit: number;
  rebalanceThreshold: number;
  useGasless?: boolean;
}

// Immutable per-execution context passed into every strategy.
export interface StrategyContext {
  strategyId: number;
  userId: number;
  walletId: number;
  address: string;
  balances: TokenBalance[];
  tokens: SwappableToken[];
  settings: TradeSettings;
  config: Record<string, unknown>;
}

// Mutable runtime state persisted between cycles in the DB state column.
// Never embed this in config — config is user intent, state is runtime bookkeeping.
export interface StrategyState {
  lastAiRefresh?: number;
  cachedTargets?: PortfolioTarget[];
  // breakout: tracks whether price was above the lookback high last cycle
  wasAboveHigh?: boolean;
  wasAboveLow?: boolean;
  [key: string]: unknown;
}

export interface Strategy {
  execute(ctx: StrategyContext, state: StrategyState): Promise<RebalanceAction[]>;
}
