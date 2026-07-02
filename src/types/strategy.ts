import type { TokenBalance, SwappableToken, RebalanceAction, PortfolioTarget } from "../types.js";
import type { MarketContext, SignalForecast } from "./market.js";
import type { Features } from "../services/quant/featureEngine.js";

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
  // Quantitative enrichments — undefined during cold-start or test stubs.
  marketContext?: MarketContext;
  features?: Map<string, Features>;
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

// Re-export for strategies that wish to emit forecasts instead of raw actions.
export type { SignalForecast };
