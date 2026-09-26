import { ConfigManager } from "../../../config.js";
import { marketDataIsExternal } from "../index.js";
import { InternalCandleSource } from "./internalCandleSource.js";
import { GeckoTerminalCandleSource } from "./geckoTerminalCandleSource.js";
import type { CandleSource } from "./types.js";

export type { CandleData, CandleQuery, CandleSource } from "./types.js";
export { InternalCandleSource } from "./internalCandleSource.js";
export { GeckoTerminalCandleSource } from "./geckoTerminalCandleSource.js";
export { BUCKET_MS, bucketStartOf, TIMEFRAME_MS, timeframeMs, candleCacheTtlSeconds } from "./interval.js";

/**
 * Resolves the configured candle source.
 *
 * `CANDLE_SOURCE` defaults to `auto`, which follows `MARKET_DATA_PROVIDER`
 * rather than standing on its own. That default exists because the two are
 * rendered on the same page: a chart drawn from our own candles under a price
 * column bought from an aggregator is two different worlds stacked on top of
 * each other, and they disagree visibly — the price label says one number and
 * the last candle closes at another.
 *
 * Setting it explicitly is for the A/B: running `internal` candles against a
 * `hybrid` price column is precisely how the two are compared before the
 * default flips.
 */
export function resolveCandleSource(): CandleSource {
  const mode = ConfigManager.getInstance().config.CANDLE_SOURCE;

  switch (mode) {
    case "geckoterminal":
      return new GeckoTerminalCandleSource();
    case "internal":
      return new InternalCandleSource();
    case "auto":
    default:
      return marketDataIsExternal()
        ? new GeckoTerminalCandleSource()
        : new InternalCandleSource();
  }
}
