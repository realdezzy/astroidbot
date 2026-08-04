import http from "node:http";
import { logger } from "./utils/logger.js";
import { ConfigManager } from "./config.js";
import { DatabaseService } from "./services/db.js";
import { RedisService } from "./services/redis.js";
import { hardenOutboundHttp, installProcessGuards, connectDatabase } from "./runtime.js";
import { registerEnabledChains } from "./services/chains/registerChains.js";
import { IndexerService } from "./services/indexer/indexerService.js";
import { runMarketDataIngestion } from "./services/indexer/ingestionCycle.js";

/**
 * The market-data indexer, as its own process.
 *
 * It shares a database and a Redis with the API process and nothing else: no
 * HTTP API, no Telegram, no queue workers, no trading cycle. It reads chain
 * logs and writes candles, pool rows and the rolled-up Token metrics the
 * discovery pages render.
 *
 * Why it is not a thread of the main process, which is where it started:
 *
 *  - **Blast radius.** Ingestion is the heaviest RPC consumer in the codebase
 *    and the one most exposed to third-party failure. Sharing an event loop
 *    with trade execution means a provider having a bad day competes with
 *    signing a swap.
 *  - **Scale shape.** The two have unrelated cost curves. Indexing more chains
 *    is RPC- and CPU-bound; serving more users is not. Together they can only
 *    be scaled by the larger of the two needs.
 *  - **Restart cost.** Adding a chain to the index restarts the indexer. It
 *    should not also drop WebSocket connections and Telegram polling.
 *
 * What it costs: mutual exclusion is now a cross-process problem. See the
 * per-chain Redis lock in IndexerService — without it, two processes reading
 * the same cursor would both ingest the same blocks and both add the volume.
 *
 * **This is the only process that ingests.** There is no flag to move
 * ingestion back into the API process, because there is no ingestion code
 * path there to enable — `runCycle()` does not call the indexer at all. A
 * deployment that doesn't want market data doesn't run this container, and
 * points MARKET_DATA_PROVIDER at something else.
 */

interface IndexerHealth {
  startedAt: Date;
  lastRunAt: Date | null;
  lastRunMs: number | null;
  lastError: string | null;
  runs: number;
  failures: number;
  consecutiveFailures: number;
}

const health: IndexerHealth = {
  startedAt: new Date(),
  lastRunAt: null,
  lastRunMs: null,
  lastError: null,
  runs: 0,
  failures: 0,
  consecutiveFailures: 0,
};

/**
 * Consecutive failures before the container reports unhealthy.
 *
 * Not one: a single failed pass is the normal response to an RPC endpoint
 * hiccuping, and restarting on it would turn a recoverable blip into a restart
 * loop that ingests nothing. Three consecutive failures is a real fault.
 */
const UNHEALTHY_AFTER_CONSECUTIVE_FAILURES = 3;

/**
 * Health endpoint. Serves the container healthcheck and nothing else — this
 * process deliberately exposes no API surface.
 */
function createHealthServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.url !== "/health" && req.url !== "/") {
      res.writeHead(404).end();
      return;
    }

    // Healthy until proven otherwise, including before the first pass
    // completes: a fresh container catching up on a cold chain can take
    // several minutes, and reporting unhealthy meanwhile would restart it
    // forever without ever finishing a pass.
    const healthy = health.consecutiveFailures < UNHEALTHY_AFTER_CONSECUTIVE_FAILURES;

    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: healthy ? "ok" : "degraded",
        service: "indexer",
        chains: IndexerService.getInstance().indexedChains(),
        uptimeSeconds: Math.round((Date.now() - health.startedAt.getTime()) / 1000),
        lastRunAt: health.lastRunAt,
        lastRunMs: health.lastRunMs,
        runs: health.runs,
        failures: health.failures,
        consecutiveFailures: health.consecutiveFailures,
        lastError: health.lastError,
      })
    );
  });
}

async function runPass(): Promise<void> {
  const startedAt = Date.now();
  try {
    await runMarketDataIngestion();
    health.consecutiveFailures = 0;
    health.lastError = null;
  } catch (error) {
    health.failures++;
    health.consecutiveFailures++;
    health.lastError = error instanceof Error ? error.message : String(error);
    logger.error("[indexer] pass failed", {
      error: health.lastError,
      consecutiveFailures: health.consecutiveFailures,
    });
  } finally {
    health.runs++;
    health.lastRunAt = new Date();
    health.lastRunMs = Date.now() - startedAt;
  }
}

async function main(): Promise<void> {
  hardenOutboundHttp();
  installProcessGuards();

  ConfigManager.load();

  await connectDatabase();

  // Same registration path as the API process. The indexer needs descriptors
  // to know which chains are indexable, and the EVM DEX providers because
  // resolving a native asset's USD price can fall back to a live router quote.
  registerEnabledChains();

  const config = ConfigManager.getInstance().config;
  const intervalSeconds = config.INDEXER_POLL_INTERVAL_SECONDS ?? config.POLL_INTERVAL_SECONDS;

  const healthServer = createHealthServer();
  await new Promise<void>((resolve) => healthServer.listen(config.INDEXER_PORT, resolve));

  logger.info("[indexer] started", {
    port: config.INDEXER_PORT,
    intervalSeconds,
    chains: IndexerService.getInstance().indexedChains(),
  });

  await runPass();

  // A pass that overruns the interval does not stack: runMarketDataIngestion
  // is guarded per chain, in-process and in Redis, so a late pass is skipped
  // rather than queued behind the one still running.
  const timer = setInterval(() => {
    void runPass();
  }, intervalSeconds * 1000);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`[indexer] received ${signal}, shutting down...`);
    clearInterval(timer);

    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await DatabaseService.getInstance().disconnect();
    await RedisService.getInstance().shutdown();

    logger.info("[indexer] shut down gracefully");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  logger.error("[indexer] fatal startup error", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
