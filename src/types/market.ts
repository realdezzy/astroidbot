// Snapshot of a single token's market state at a point in time.
export interface TokenMarketSnapshot {
  token: string;
  currentPriceUsd: number;
  // Liquidity & depth
  bidAskSpreadPct: number;
  poolLiquidityUsd: number;
  poolDepth1PctUsd: number; // Max safe trade size before 1% price impact
  poolTvlUsd: number;
  poolApr: number;
  // Volatility
  volatility30m: number; // Realized volatility, 30-minute window
  volatility24h: number; // Realized volatility, 24-hour window
  atr: number;           // Average True Range (absolute price units)
  bollingerWidth: number; // (Upper - Lower) / Middle Band
  // Momentum & trend
  return1h: number;
  return4h: number;
  return24h: number;
  return7d: number;
  rsi14: number;           // RSI over 14 periods
  macdHistogram: number;   // MACD histogram value
  vwapDistance: number;    // (Price - VWAP) / VWAP
  // Volume
  volume24hUsd: number;
  volumeTrend: number;    // Volume this hour vs rolling 24h average (ratio)
  buySellRatio: number;   // Buy volume / Sell volume (> 1 = net buying)
  // On-chain / whale
  whaleTxCount24h: number;
  netWhaleFlowUsd: number; // Net USD flow from wallets > threshold
  // AI-enriched
  sentimentScore: number; // [-1, 1]: -1 bearish, 0 neutral, +1 bullish
}

// Full market context snapshot passed to every strategy and the signal fusion layer.
export interface MarketContext {
  timestamp: number;
  snapshots: Map<string, TokenMarketSnapshot>;
  macroRegime: MarketRegime;
  correlationMatrix: Map<string, Map<string, number>>;
}

// Detected market regime used to gate which strategies are allowed to act.
export type MarketRegime =
  | "TRENDING_BULL"
  | "TRENDING_BEAR"
  | "RANGING_HIGH_VOL"
  | "RANGING_LOW_VOL"
  | "CAPITULATION"
  | "UNKNOWN";

// Signal output from a strategy acting as a signal generator.
export interface SignalForecast {
  strategyId: number;
  token: string;
  direction: "BUY" | "SELL" | "HOLD";
  // Range [0, 1]. Strategies with no data should return 0 confidence.
  confidence: number;
  // Estimated annualised percentage return if signal is correct.
  expectedReturn: number;
  // Estimated maximum adverse excursion (drawdown %) if signal is wrong.
  expectedRisk: number;
  rationale: string[];
}
