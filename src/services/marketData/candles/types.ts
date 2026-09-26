/** One candle, in the shape every chart and every backtest consumes. */
export interface CandleData {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: Date;
}

/**
 * Which token a caller wants candles for.
 *
 * Both identifiers are optional and at least one must be present, because the
 * two call sites genuinely know different things: the discovery route holds a
 * `contractId` (it just looked the token up by one), while the feature engine
 * and the backtester hold a symbol. Forcing either to fabricate the other is
 * how a chart ends up drawn for a same-ticker token on the wrong chain.
 */
export interface CandleQuery {
  chainId: string;
  contractId?: string;
  symbol?: string;
}

/**
 * A source of historical candles.
 *
 * The second seam of the hybrid split, and the one that did not exist before:
 * `CandleService` used to query `poolCandle` / `indexedPool` / `indexedToken`
 * directly, so a chart was hard-wired to our own swap index. Two
 * implementations now sit behind this type — `internal` is those same queries
 * moved verbatim, which is what keeps `INDEXER_MODE=full` a working rollback
 * rather than a claim, and `geckoterminal` buys the same series from an API.
 *
 * Sources differ in the resolution they return, which is what
 * `needsAggregation` exists to say. The internal one returns raw five-minute
 * buckets and `CandleService` folds them; the external one is asked for the
 * timeframe directly and returns it already folded. Folding twice would be
 * silently wrong rather than loud, since re-aggregating aggregated candles
 * produces a plausible chart with the wrong opens.
 */
export interface CandleSource {
  readonly name: string;

  /** Rows arrive as 5-minute buckets that the caller must fold. */
  readonly needsAggregation: boolean;

  /**
   * Whether this source can serve a timeframe at all.
   *
   * The internal index cannot go below its five-minute bucket — anything finer
   * would have to be interpolated, which is precisely the fabrication this
   * service stopped doing. The external API serves one-minute candles, so the
   * answer genuinely differs by source rather than being a global property.
   */
  supportsTimeframe(timeframe: string): boolean;

  /** The most recent `limit` candles of the given timeframe, chronological. */
  getCandles(query: CandleQuery, timeframe: string, limit: number): Promise<CandleData[]>;

  /**
   * The same series bounded by dates rather than a count.
   *
   * Backtests need this shape: "every candle between these two dates" cannot
   * be expressed as a limit, because how many candles that is depends on how
   * much the token traded.
   */
  getCandlesBetween(
    query: CandleQuery,
    timeframe: string,
    startDate: Date,
    endDate: Date
  ): Promise<CandleData[]>;
}
