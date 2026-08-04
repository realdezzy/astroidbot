import { logger } from "../../utils/logger.js";
import { IndexerService } from "./indexerService.js";
import { RollupService } from "./rollupService.js";

/**
 * One market-data pass: ingest, then roll up, then occasionally prune.
 *
 * Ordering is not incidental. The rollup reads candles the ingestion pass just
 * wrote, so running them concurrently would publish metrics one tick stale for
 * no benefit. Pruning runs last and rarely — it is pure housekeeping and must
 * never delay the numbers the UI is waiting on.
 */

/** Ticks between candle prunes. Retention is measured in days; this needn't be tight. */
const PRUNE_EVERY_N_RUNS = 100;

let runCount = 0;

export async function runMarketDataIngestion(): Promise<void> {
  const indexer = IndexerService.getInstance();
  if (!indexer.enabled()) return;

  const results = await indexer.runAll();
  if (results.length === 0) return;

  // Roll up only the chains that actually moved. A chain with no new swaps has
  // no new candles, and re-aggregating it would be a full scan for an
  // unchanged answer.
  const touched = results
    .filter((r) => r.swapsIngested > 0 || r.poolsDiscovered > 0)
    .map((r) => r.chainId);

  if (touched.length > 0) {
    const updated = await RollupService.getInstance().rollupAll(touched);
    if (updated > 0) logger.debug("[marketData] rolled up tokens", { updated, chains: touched });
  }

  if (++runCount % PRUNE_EVERY_N_RUNS === 0) {
    await RollupService.getInstance()
      .pruneOldCandles()
      .catch((err) => logger.warn("[marketData] prune failed", { error: err }));
  }
}

/** Test seam: the prune counter is module state and would otherwise leak between suites. */
export function resetIngestionCycle(): void {
  runCount = 0;
}
