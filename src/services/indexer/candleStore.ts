import { Prisma } from "@prisma/client";
import type { CandleBucket } from "./types.js";

/**
 * Persists 5-minute candles.
 *
 * Written as one raw multi-row upsert rather than a loop of Prisma upserts for
 * two reasons, both load-bearing:
 *
 *  - `high` and `low` need GREATEST/LEAST against the row already stored, and
 *    Prisma's update syntax has no way to express "max of current and new".
 *    Read-modify-write in application code would race with itself the moment
 *    two chains flush concurrently.
 *  - A busy range produces thousands of buckets. One statement is a single
 *    round trip; a loop is thousands, and it dominates the tick.
 *
 * `open` is deliberately never updated — the first write for a bucket wins,
 * and swaps are always applied in block order, so that is the opening price.
 */
export function buildCandleUpsert(buckets: CandleBucket[]): Prisma.Sql {
  const values = buckets.map(
    (b) => Prisma.sql`(
      ${b.poolId},
      ${b.bucketStart},
      ${b.open},
      ${b.high},
      ${b.low},
      ${b.close},
      ${b.volumeUsd},
      ${b.buys},
      ${b.sells}
    )`
  );

  return Prisma.sql`
    INSERT INTO "PoolCandle"
      ("poolId", "bucketStart", "open", "high", "low", "close", "volumeUsd", "buys", "sells")
    VALUES ${Prisma.join(values, ",")}
    ON CONFLICT ("poolId", "bucketStart") DO UPDATE SET
      "high"      = GREATEST("PoolCandle"."high", EXCLUDED."high"),
      "low"       = LEAST("PoolCandle"."low", EXCLUDED."low"),
      "close"     = EXCLUDED."close",
      "volumeUsd" = "PoolCandle"."volumeUsd" + EXCLUDED."volumeUsd",
      "buys"      = "PoolCandle"."buys" + EXCLUDED."buys",
      "sells"     = "PoolCandle"."sells" + EXCLUDED."sells"
  `;
}

/**
 * Accumulates swaps into buckets in memory.
 *
 * Aggregating before writing is what keeps the storage bounded: a chain can
 * emit millions of swaps a day, and this collapses them to 288 rows per pool
 * per day before any of it reaches Postgres.
 */
export class CandleAccumulator {
  private buckets = new Map<string, CandleBucket>();

  add(
    poolId: number,
    bucketStart: Date,
    price: number,
    volumeUsd: number,
    isBuy: boolean
  ): void {
    const key = `${poolId}:${bucketStart.getTime()}`;
    const existing = this.buckets.get(key);

    if (!existing) {
      this.buckets.set(key, {
        poolId,
        bucketStart,
        open: price,
        high: price,
        low: price,
        close: price,
        volumeUsd,
        buys: isBuy ? 1 : 0,
        sells: isBuy ? 0 : 1,
      });
      return;
    }

    // A zero/absent price must not drag the low to zero — it means we could
    // not price that swap, not that the pool traded at nothing.
    if (price > 0) {
      if (existing.open === 0) existing.open = price;
      if (price > existing.high) existing.high = price;
      if (existing.low === 0 || price < existing.low) existing.low = price;
      existing.close = price;
    }

    existing.volumeUsd += volumeUsd;
    if (isBuy) existing.buys++;
    else existing.sells++;
  }

  values(): CandleBucket[] {
    return [...this.buckets.values()];
  }

  get size(): number {
    return this.buckets.size;
  }
}
