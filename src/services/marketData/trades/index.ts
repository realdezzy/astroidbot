import { marketDataIsExternal } from "../index.js";
import { InternalTradesSource } from "./internalTradesSource.js";
import { GeckoTerminalTradesSource } from "./geckoTerminalTradesSource.js";
import type { TradesSource } from "./types.js";

export type { SwapFeed, TokenSwap, TokenTrader, TraderFeed, TradesSource } from "./types.js";
export { InternalTradesSource } from "./internalTradesSource.js";
export { GeckoTerminalTradesSource } from "./geckoTerminalTradesSource.js";

/**
 * Resolves the trade-activity source.
 *
 * It follows `MARKET_DATA_PROVIDER` rather than taking a flag of its own,
 * because there is no coherent deployment where it should disagree: the swap
 * feed comes from the same swaps the price column is computed from, and under
 * `INDEXER_MODE=discovery` the internal table stops gaining rows entirely.
 * A "recent trades" panel whose most recent trade is from whenever ingestion
 * was turned off is worse than one that says it has nothing.
 */
export function resolveTradesSource(): TradesSource {
  return marketDataIsExternal() ? new GeckoTerminalTradesSource() : new InternalTradesSource();
}
