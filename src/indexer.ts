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

const UNHEALTHY_AFTER_CONSECUTIVE_FAILURES = 3;

function createHealthServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.url !== "/health" && req.url !== "/") {
      res.writeHead(404).end();
      return;
    }

    const healthy = health.consecutiveFailures < UNHEALTHY_AFTER_CONSECUTIVE_FAILURES;

    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: healthy ? "ok" : "degraded",
        service: "indexer",
        chains: IndexerService.getInstance().indexedChains(),
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
