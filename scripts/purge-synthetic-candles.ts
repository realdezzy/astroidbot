/**
 * Empties the `Candle` table, every row of which was fabricated.
 *
 * `CandleService.autoSeed` generated OHLCV from `Math.random()` — a random
 * walk from spot for the prices, and `1000 + Math.random() * 10000` for the
 * volume, which is not an approximation of anything — and persisted it with
 * `createMany` whenever a read found no rows. The chart endpoint, the feature
 * engine, portfolio analytics and the backtest engine all read it back, with
 * nothing to mark it as invented.
 *
 * There is no heuristic here because none is needed. `recordPrice` was the
 * only code that would ever have written a real row to this table and nothing
 * ever called it, so the fabricated rows are not *some* of the contents —
 * they are all of it. Candles now come from `PoolCandle`, which the indexer
 * folds from swap logs it actually read.
 *
 *   npx tsx scripts/purge-synthetic-candles.ts            # count only
 *   npx tsx scripts/purge-synthetic-candles.ts --apply    # delete
 *
 * Dry by default: deleting rows is the destructive direction, so it should not
 * be what happens when you forget a flag.
 */
import { ConfigManager } from "../src/config.js";
import { DatabaseService } from "../src/services/db.js";
import { logger } from "../src/utils/logger.js";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  ConfigManager.load();
  const db = DatabaseService.connect();

  const total = await db.prisma.candle.count();

  if (total === 0) {
    logger.info("[purge-synthetic-candles] table is already empty");
    await db.disconnect();
    return;
  }

  // Reported per chain and timeframe so the scale of what was being served is
  // visible before it goes, rather than a single number.
  const breakdown = await db.prisma.candle.groupBy({
    by: ["chainId", "timeframe"],
    _count: { _all: true },
  });

  logger.info("[purge-synthetic-candles] fabricated rows found", {
    total,
    breakdown: breakdown.map((row) => ({
      chainId: row.chainId,
      timeframe: row.timeframe,
      rows: row._count._all,
    })),
  });

  if (!apply) {
    logger.warn(
      `[purge-synthetic-candles] ${total} row(s) would be deleted. Re-run with --apply.`
    );
    await db.disconnect();
    return;
  }

  const { count } = await db.prisma.candle.deleteMany({});
  logger.info("[purge-synthetic-candles] deleted", { count });

  await db.disconnect();
}

main().catch((error) => {
  logger.error("[purge-synthetic-candles] failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
