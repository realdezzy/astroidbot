/** One trade against a token, as the activity panel renders it. */
export interface TokenSwap {
  /** Full transaction identifier. The route shortens it for display. */
  txHash: string;
  timestamp: Date;
  isBuy: boolean;
  /** Null when the trade was seen but could not be valued in dollars. */
  volumeUsd: number | null;
  priceUsd: number | null;
  traderAddress: string | null;
}

/** One entry in the top-traders leaderboard. */
export interface TokenTrader {
  address: string;
  volumeUsd: number | null;
  trades: number;
}

/**
 * What a source can say about a token's recent activity.
 *
 * `note` carries the reason a list is empty, which the UI shows instead of an
 * empty table: "no pools indexed for this token" and "this token has not
 * traded" look identical as an empty array and mean different things.
 */
export interface SwapFeed {
  swaps: TokenSwap[];
  note?: string;
}

export interface TraderFeed {
  traders: TokenTrader[];
  note?: string;
}

/**
 * A source of per-token trade activity.
 *
 * This seam did not exist: `/swaps` and `/traders` queried `indexedSwap`
 * inline in the route handler, which meant the two most swap-shaped surfaces
 * in the product were the only ones that could not follow the market-data
 * provider anywhere. They are extracted here for the same reason
 * `MarketDataProvider` exists — so where the numbers come from is a config
 * decision rather than a rewrite of a route.
 *
 * Both implementations are bounded by a recent window rather than by all of
 * history. These panels render "recent trades" and "top traders", so a window
 * is what they actually mean, and without one the internal query scans every
 * swap retained for the token's pools — which grows with the product's success
 * rather than with the size of the answer.
 */
export interface TradesSource {
  readonly name: string;

  /** Most recent trades, newest first. */
  recentSwaps(chainId: string, contractId: string, limit: number): Promise<SwapFeed>;

  /** Highest-volume traders over the activity window. */
  topTraders(chainId: string, contractId: string, limit: number): Promise<TraderFeed>;
}
