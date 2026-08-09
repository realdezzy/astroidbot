import http from "node:http";
import { logger } from "./utils/logger.js";
import { ConfigManager } from "./config.js";
import { DatabaseService } from "./services/db.js";
import { RedisService } from "./services/redis.js";
import { hardenOutboundHttp, installProcessGuards, connectDatabase } from "./runtime.js";
import { registerEnabledChains } from "./services/chains/registerChains.js";
import { ChainHealthMonitor } from "./services/chains/chainHealth.js";
import { IndexerService } from "./services/indexer/indexerService.js";
import { runMarketDataIngestion } from "./services/indexer/ingestionCycle.js";

/**
 * The market-data indexer, as its own process.
 *
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
        // Per-chain detail, so "the indexer is up but Celo has been failing
        // for an hour" is answerable without reading logs. It does not affect
        // the status code: one unreachable chain is degraded capability, not a
        // reason to restart a container that is ingesting four others fine.
        chainHealth: ChainHealthMonitor.getInstance().snapshot(),
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
