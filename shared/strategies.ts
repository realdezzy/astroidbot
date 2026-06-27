import type { StrategyDef } from "./types.js";

export const STRATEGY_TYPES = [
  "portfolio_rebalance", "grid", "dca", "sniper", "copy",
  "momentum", "mean_reversion", "twap", "stop_loss_tp", "rotational", "breakout",
] as const;

export const STRATEGY_REGISTRY: StrategyDef[] = [
  {
    type: "portfolio_rebalance",
    label: "Portfolio Rebalance",
    desc: "AI-driven weight-based portfolio rebalancing. Requires AI.",
    defaults: { rebalanceThreshold: 2, maxPositionPct: 25, useAI: true, aiRefreshMinutes: 15, maxSlippageBps: 100, tokenUniverse: "", minTradeUsd: 5 },
    fields: [
      { key: "rebalanceThreshold", label: "Rebalance Threshold (%)", type: "number", placeholder: "2", step: "0.5" },
      { key: "maxPositionPct", label: "Max Position (%)", type: "number", placeholder: "25", step: "1" },
      { key: "useAI", label: "Use AI targets (true/false)", type: "text", placeholder: "true" },
      { key: "aiRefreshMinutes", label: "AI Refresh (min)", type: "number", placeholder: "15" },
      { key: "maxSlippageBps", label: "Max Slippage (bps)", type: "number", placeholder: "100" },
      { key: "tokenUniverse", label: "Token Universe (CSV)", type: "text", placeholder: "STX,ALEX,sUSDT" },
      { key: "minTradeUsd", label: "Min Trade ($)", type: "number", placeholder: "5" },
    ],
  },
  {
    type: "grid",
    label: "Grid Market Making",
    desc: "Buy/sell at fixed price intervals. AI configures spreads.",
    defaults: { tokenPair: "STX/sUSDT", levels: 5, spreadBps: 30, maxPositionPct: 25, useAI: true, aiRefreshMinutes: 30, gridRangePct: 5, totalCapitalUsd: 50 },
    fields: [
      { key: "tokenPair", label: "Token Pair (e.g. STX/sUSDT)", type: "text", placeholder: "STX/sUSDT" },
      { key: "levels", label: "Grid Levels (3-10)", type: "number", placeholder: "5" },
      { key: "spreadBps", label: "Spread (bps per level)", type: "number", placeholder: "30" },
      { key: "maxPositionPct", label: "Max Position (%)", type: "number", placeholder: "25" },
      { key: "useAI", label: "Use AI for spreads", type: "text", placeholder: "true" },
      { key: "aiRefreshMinutes", label: "AI Refresh (min)", type: "number", placeholder: "30" },
      { key: "gridRangePct", label: "Grid Range (%)", type: "number", placeholder: "5" },
      { key: "totalCapitalUsd", label: "Total Capital ($)", type: "number", placeholder: "50" },
    ],
  },
  {
    type: "dca",
    label: "Dollar Cost Average",
    desc: "Auto-buy fixed amount at regular intervals with price conditions.",
    defaults: { tokenIn: "STX", tokenOut: "sUSDT", amount: 1, intervalMinutes: 60, priceCondition: "always", priceThresholdUsd: 0, maxSlippageBps: 100, totalBudgetUsd: 0 },
    fields: [
      { key: "tokenIn", label: "From Token", type: "text", placeholder: "STX" },
      { key: "tokenOut", label: "To Token", type: "text", placeholder: "sUSDT" },
      { key: "amount", label: "Amount per Buy", type: "number", placeholder: "1", step: "0.1" },
      { key: "intervalMinutes", label: "Interval (min)", type: "number", placeholder: "60" },
      { key: "priceCondition", label: "Price Condition (always/below/above)", type: "text", placeholder: "always" },
      { key: "priceThresholdUsd", label: "Price Threshold ($)", type: "number", placeholder: "0" },
      { key: "maxSlippageBps", label: "Max Slippage (bps)", type: "number", placeholder: "100" },
      { key: "totalBudgetUsd", label: "Total Budget ($, 0=unlimited)", type: "number", placeholder: "0" },
    ],
  },
  {
    type: "sniper",
    label: "Token Sniper",
    desc: "Auto-buy new tokens matching watchlist with liquidity/impact filters.",
    defaults: { watchTokens: "", maxBuyAmount: 1, perTokenCapUsd: 5, maxPriceImpactPct: 5, slippageBps: 100, cooldownMinutes: 60 },
    fields: [
      { key: "watchTokens", label: "Watch Tokens (CSV)", type: "text", placeholder: "ALEX,WELSH" },
      { key: "maxBuyAmount", label: "Max Buy per Token (STX)", type: "number", placeholder: "1", step: "0.1" },
      { key: "perTokenCapUsd", label: "Per-Token Cap ($)", type: "number", placeholder: "5" },
      { key: "maxPriceImpactPct", label: "Max Price Impact (%)", type: "number", placeholder: "5" },
      { key: "slippageBps", label: "Slippage (bps)", type: "number", placeholder: "100" },
      { key: "cooldownMinutes", label: "Cooldown (min)", type: "number", placeholder: "60" },
    ],
  },
  {
    type: "copy",
    label: "Copy Trading",
    desc: "Mirror trades from a watched wallet with configurable ratio.",
    defaults: { targetAddress: "", maxPerTrade: 10, maxCopiesPerCycle: 3, copyRatio: 1, delaySeconds: 0 },
    fields: [
      { key: "targetAddress", label: "Target Wallet Address", type: "text", placeholder: "SP..." },
      { key: "maxPerTrade", label: "Max Per Trade (STX)", type: "number", placeholder: "10", step: "1" },
      { key: "maxCopiesPerCycle", label: "Max Copies/Cycle", type: "number", placeholder: "3" },
      { key: "copyRatio", label: "Copy Ratio", type: "number", placeholder: "1", step: "0.1" },
      { key: "delaySeconds", label: "Delay Between Copies (s)", type: "number", placeholder: "0" },
    ],
  },
  {
    type: "momentum",
    label: "Momentum / Trend",
    desc: "Buy tokens with strong positive returns, exit on reversal.",
    defaults: { lookbackPeriods: 20, momentumThresholdPct: 2, exitThresholdPct: -1, positionSizeUsd: 10, tokenUniverse: "" },
    fields: [
      { key: "lookbackPeriods", label: "Lookback Periods", type: "number", placeholder: "20" },
      { key: "momentumThresholdPct", label: "Entry Threshold (%)", type: "number", placeholder: "2" },
      { key: "exitThresholdPct", label: "Exit Threshold (%)", type: "number", placeholder: "-1" },
      { key: "positionSizeUsd", label: "Position Size ($)", type: "number", placeholder: "10" },
      { key: "tokenUniverse", label: "Token Universe (CSV)", type: "text", placeholder: "ALEX,WELSH,DIKO" },
    ],
  },
  {
    type: "mean_reversion",
    label: "Mean Reversion",
    desc: "Buy when price deviates below MA, sell when above.",
    defaults: { maPeriods: 20, entryDeviationPct: 5, exitDeviationPct: 1, tokenPair: "STX/sUSDT", positionSizeUsd: 10 },
    fields: [
      { key: "maPeriods", label: "MA Periods", type: "number", placeholder: "20" },
      { key: "entryDeviationPct", label: "Entry Deviation (%)", type: "number", placeholder: "5" },
      { key: "exitDeviationPct", label: "Exit Deviation (%)", type: "number", placeholder: "1" },
      { key: "tokenPair", label: "Token Pair", type: "text", placeholder: "STX/sUSDT" },
      { key: "positionSizeUsd", label: "Position Size ($)", type: "number", placeholder: "10" },
    ],
  },
  {
    type: "twap",
    label: "TWAP (Time-Weighted)",
    desc: "Split large order into equal slices over a time window.",
    defaults: { tokenIn: "STX", tokenOut: "sUSDT", totalAmount: 10, slices: 10, windowMinutes: 60, maxSlippageBps: 100 },
    fields: [
      { key: "tokenIn", label: "From Token", type: "text", placeholder: "STX" },
      { key: "tokenOut", label: "To Token", type: "text", placeholder: "sUSDT" },
      { key: "totalAmount", label: "Total Amount", type: "number", placeholder: "10" },
      { key: "slices", label: "Slices", type: "number", placeholder: "10" },
      { key: "windowMinutes", label: "Window (min)", type: "number", placeholder: "60" },
      { key: "maxSlippageBps", label: "Max Slippage (bps)", type: "number", placeholder: "100" },
    ],
  },
  {
    type: "stop_loss_tp",
    label: "Stop Loss / Take Profit",
    desc: "Auto-exit positions at profit target or loss limit. Supports trailing stop.",
    defaults: { token: "", takeProfitPct: 10, stopLossPct: 5, trailingStopPct: 0 },
    fields: [
      { key: "token", label: "Token Symbol", type: "text", placeholder: "ALEX" },
      { key: "takeProfitPct", label: "Take Profit (%)", type: "number", placeholder: "10" },
      { key: "stopLossPct", label: "Stop Loss (%)", type: "number", placeholder: "5" },
      { key: "trailingStopPct", label: "Trailing Stop (%)", type: "number", placeholder: "0" },
    ],
  },
  {
    type: "rotational",
    label: "Momentum Rotation",
    desc: "Periodically rotate capital into top-performing tokens.",
    defaults: { topK: 3, rebalancePeriodHours: 24, positionSizeUsd: 10, tokenUniverse: "" },
    fields: [
      { key: "topK", label: "Top K", type: "number", placeholder: "3" },
      { key: "rebalancePeriodHours", label: "Rebalance Period (hrs)", type: "number", placeholder: "24" },
      { key: "positionSizeUsd", label: "Position Size ($)", type: "number", placeholder: "10" },
      { key: "tokenUniverse", label: "Token Universe (CSV)", type: "text", placeholder: "ALEX,WELSH,DIKO" },
    ],
  },
  {
    type: "breakout",
    label: "Range Breakout",
    desc: "Buy on breakout above resistance, sell on breakdown.",
    defaults: { lookbackPeriods: 20, breakoutPct: 3, tokenPair: "STX/sUSDT", positionSizeUsd: 10 },
    fields: [
      { key: "lookbackPeriods", label: "Lookback Periods", type: "number", placeholder: "20" },
      { key: "breakoutPct", label: "Breakout Threshold (%)", type: "number", placeholder: "3" },
      { key: "tokenPair", label: "Token Pair", type: "text", placeholder: "STX/sUSDT" },
      { key: "positionSizeUsd", label: "Position Size ($)", type: "number", placeholder: "10" },
    ],
  },
];

export const STRATEGY_FIELDS: Record<string, string[]> = {};
export const STRATEGY_LABELS: Record<string, string> = {};
export const STRATEGY_DEFAULTS: Record<string, Record<string, unknown>> = {};

for (const s of STRATEGY_REGISTRY) {
  STRATEGY_FIELDS[s.type] = s.fields.map((f) => f.key);
  STRATEGY_DEFAULTS[s.type] = { ...s.defaults };
  for (const f of s.fields) {
    STRATEGY_LABELS[f.key] = f.label;
  }
}
