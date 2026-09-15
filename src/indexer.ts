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

    const ingestionHealth = IndexerService.getInstance().healthSnapshot();
    const healthy = ingestionHealth.healthy && health.consecutiveFailures < UNHEALTHY_AFTER_CONSECUTIVE_FAILURES;

    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: healthy ? "ok" : "degraded",
        service: "indexer",
        ingestionHealth,
        chains: IndexerService.getInstance().indexedChains(),
        chainHealth: ChainHealthMonitor.getInstance().snapshot(),
        // Per-chain cursor progress. A stalled chain reports no errors and a
        // rising run count, so neither of those can distinguish "caught up and
        // quiet" from "every range refused" — this can.
        ingestion: IndexerService.getInstance().progressSnapshot(),
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

let activePass: Promise<void> | null = null;
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

  activePass = runPass();
  await activePass;
  activePass = null;

  const timer = setInterval(() => {
    if (!activePass) activePass = runPass().finally(() => { activePass = null; });
  }, intervalSeconds * 1000);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`[indexer] received ${signal}, shutting down...`);
    clearInterval(timer);

    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await activePass;
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
