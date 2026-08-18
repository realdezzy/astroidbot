import { Prisma } from "@prisma/client";
import { DatabaseService } from "../db.js";
import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";

/**
 * Stores swaps and derives candles from them.
 *
 * This replaces an accumulate-on-write design in which candle volume was added
 * to in place. That one choice — `volume = volume + new` — is what forced
 * everything else in the indexer to be defensive, because it made
 * re-processing a range silently and permanently wrong. The cross-process
 * Redis lock, the transaction-wrapped cursor, the refusal to step over an
 * unreadable gap, the careful backfill seeding, the migration that marks
 * pre-existing chains complete: all of it exists to enforce "never process a
 * range twice".
 *
 * Storing the swaps under their own on-chain identity inverts that. A replay
 * inserts nothing, and a bucket is *recomputed* from what is stored rather
 * than added to, so the same range applied ten times produces the same numbers
 * as applying it once. The guards above remain — they still save real work —
 * but none of them is load-bearing for correctness any more.
 *
 * It also makes something possible that was not before: a reorg can be
 * repaired by deleting the affected swaps and recomputing the buckets they
 * touched. Addition has no inverse; this does.
 */

export interface RawSwap {
  poolId: number;
  txKey: string;
  blockNumber: bigint;
  logIndex: number;
  bucketStart: Date;
  priceUsd: number;
  volumeUsd: number;
  isBuy: boolean;
  traderAddress?: string;
}

export async function persistSwaps(swaps: RawSwap[]): Promise<number> {
  if (swaps.length === 0) return 0;

  const db = DatabaseService.getInstance();

  await db.prisma.indexedSwap.createMany({
    data: swaps.map((s) => ({
      poolId: s.poolId,
      txKey: s.txKey,
      blockNumber: s.blockNumber,
      logIndex: s.logIndex,
      bucketStart: s.bucketStart,
      priceUsd: s.priceUsd,
      volumeUsd: s.volumeUsd,
      isBuy: s.isBuy,
      traderAddress: s.traderAddress ?? null,
    })),
    skipDuplicates: true,
  });

  const pools = [...new Set(swaps.map((s) => s.poolId))];
  const buckets = [...new Set(swaps.map((s) => s.bucketStart.getTime()))].map((t) => new Date(t));

  return recomputeCandles(pools, buckets);
}

/**
 * Rebuilds candles for the given pool/bucket pairs from stored swaps.
 *
 * Every column is `SET`, never `+=`. That is the difference that matters: the
 * result depends only on what is in `IndexedSwap`, so it is the same however
 * many times this runs.
 *
 * Prices of zero are excluded from OHLC but not from volume or counts. A swap
 * we saw and could not price still happened — it belongs in the transaction
 * count — but letting its zero into `low` would report the pool as having
 * traded at nothing.
 */
export async function recomputeCandles(poolIds: number[], buckets: Date[]): Promise<number> {
  if (poolIds.length === 0 || buckets.length === 0) return 0;

  const db = DatabaseService.getInstance();

  const written = await db.prisma.$executeRaw(Prisma.sql`
    INSERT INTO "PoolCandle"
      ("poolId", "bucketStart", "open", "high", "low", "close", "volumeUsd", "buys", "sells")
    SELECT
      s."poolId",
      s."bucketStart",
      COALESCE((array_agg(s."priceUsd" ORDER BY s."blockNumber" ASC, s."logIndex" ASC)
        FILTER (WHERE s."priceUsd" > 0))[1], 0)                                   AS "open",
      COALESCE(MAX(s."priceUsd") FILTER (WHERE s."priceUsd" > 0), 0)              AS "high",
      COALESCE(MIN(s."priceUsd") FILTER (WHERE s."priceUsd" > 0), 0)              AS "low",
      COALESCE((array_agg(s."priceUsd" ORDER BY s."blockNumber" DESC, s."logIndex" DESC)
        FILTER (WHERE s."priceUsd" > 0))[1], 0)                                   AS "close",
      COALESCE(SUM(s."volumeUsd"), 0)                                             AS "volumeUsd",
      COUNT(*) FILTER (WHERE s."isBuy")                                           AS "buys",
      COUNT(*) FILTER (WHERE NOT s."isBuy")                                       AS "sells"
    FROM "IndexedSwap" s
    WHERE s."poolId" = ANY(${poolIds})
      AND s."bucketStart" = ANY(${buckets})
    GROUP BY s."poolId", s."bucketStart"
    ON CONFLICT ("poolId", "bucketStart") DO UPDATE SET
      "open"      = EXCLUDED."open",
      "high"      = EXCLUDED."high",
      "low"       = EXCLUDED."low",
      "close"     = EXCLUDED."close",
      "volumeUsd" = EXCLUDED."volumeUsd",
      "buys"      = EXCLUDED."buys",
      "sells"     = EXCLUDED."sells"
  `);

  return written;
}

/**
 * Deletes swaps in a block range and rebuilds the buckets they were in.
 *
 * The reorg repair that additive accumulation made impossible. Nothing calls
 * this on a schedule — it is the tool for when a chain rewrites history deeper
 * than `INDEXER_CONFIRMATIONS`, which is rare and, before this, unrecoverable
 * without discarding the pool's candles entirely.
 */
export async function rollbackFrom(chainId: string, fromBlock: bigint): Promise<number> {
  const db = DatabaseService.getInstance();

  const affected = await db.prisma.indexedSwap.findMany({
    where: { blockNumber: { gte: fromBlock }, pool: { chainId } },
    select: { poolId: true, bucketStart: true },
  });

  if (affected.length === 0) return 0;

  await db.prisma.indexedSwap.deleteMany({
    where: { blockNumber: { gte: fromBlock }, pool: { chainId } },
  });

  const pools = [...new Set(affected.map((a) => a.poolId))];
  const buckets = [...new Set(affected.map((a) => a.bucketStart.getTime()))].map((t) => new Date(t));

  // Buckets whose every swap was rolled back produce no row here and keep
  // their old values, so they are zeroed explicitly first.
  await db.prisma.poolCandle.updateMany({
    where: { poolId: { in: pools }, bucketStart: { in: buckets } },
    data: { open: 0, high: 0, low: 0, close: 0, volumeUsd: 0, buys: 0, sells: 0 },
  });

  await recomputeCandles(pools, buckets);

  logger.warn("[indexer] rolled back swaps", { chainId, fromBlock: fromBlock.toString(), swaps: affected.length });
  return affected.length;
}

/**
 * Drops raw swaps past their retention horizon.
 *
 * Shorter than the candle retention on purpose: a raw row exists so a bucket
 * can be recomputed, and a bucket old enough that nothing will rewrite it no
 * longer needs its inputs kept. The candles derived from them stay.
 */
export async function pruneOldSwaps(): Promise<number> {
  const days = ConfigManager.getInstance().config.INDEXER_SWAP_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 86_400_000);

  const { count } = await DatabaseService.getInstance().prisma.indexedSwap.deleteMany({
    where: { bucketStart: { lt: cutoff } },
  });

  if (count > 0) logger.info("[indexer] pruned raw swaps", { count, days });
  return count;
}
