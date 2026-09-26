/**
 * Candle resolutions, in one place both sides of the seam can import.
 *
 * `BUCKET_MS` used to live in `src/services/indexer/types.ts`, which made the
 * quant layer's chart service import from the indexer — a dependency that read
 * as "charts are an indexer feature" and stopped being true the moment candles
 * could come from an external API instead. The constant is the *storage*
 * resolution of a candle, not a property of the thing that wrote it, so it
 * belongs beside the candle sources. The indexer re-exports it so nothing that
 * imported it from there had to move.
 */

/** Bucket width for stored candles. Every UI window derives from these. */
export const BUCKET_MS = 5 * 60 * 1000;

/** Floors a timestamp to its 5-minute bucket boundary. */
export function bucketStartOf(timestamp: number): Date {
  return new Date(Math.floor(timestamp / BUCKET_MS) * BUCKET_MS);
}

/** The timeframes the product offers, as milliseconds. */
export const TIMEFRAME_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export function timeframeMs(timeframe: string): number | null {
  return TIMEFRAME_MS[timeframe] ?? null;
}

/**
 * How long a served candle set may be reused, scaled to its own resolution.
 *
 * A 5-minute candle stops changing five minutes after it opens; a daily one
 * does not settle for a day. Caching both for the same sixty seconds either
 * serves a stale chart or spends the request budget redrawing a line that
 * cannot have moved — and the request budget is the binding constraint on the
 * external source.
 *
 * Capped well below the timeframe itself, because the *last* candle in the set
 * is always the open one.
 */
export function candleCacheTtlSeconds(timeframe: string): number {
  const interval = timeframeMs(timeframe);
  if (interval === null) return 60;
  return Math.max(30, Math.min(600, Math.round(interval / 1000 / 5)));
}
