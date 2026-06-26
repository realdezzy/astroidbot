import type { Server } from "node:http";
import { logger } from "./utils/logger.js";
import { ConfigManager } from "./config.js";
import { DatabaseService } from "./services/db.js";
import { TelegramService } from "./services/telegram.js";
import { WebSocketManager } from "./api/websocket.js";
import { RedisService } from "./services/redis.js";
import { QueueManager, QUEUES } from "./services/queue.js";
import { BotStatus } from "./types.js";
import { bootstrap } from "./bootstrap.js";
import { runCycle } from "./engine/cycleOrchestrator.js";
import { processTradeJob } from "./workers/tradeWorker.js";
import { processConfirmJob } from "./workers/confirmWorker.js";


async function main(): Promise<void> {
  const httpServer: Server = await bootstrap();

  // Register job queue workers
  const qm = QueueManager.getInstance();
  qm.registerWorker(QUEUES.TRADE_EXECUTION, processTradeJob, 5);
  qm.registerWorker(QUEUES.TRADE_CONFIRMATION, processConfirmJob, 3);
  logger.info("Job queue workers started");

  const cm = ConfigManager.getInstance();
  const pollInterval = cm.config.POLL_INTERVAL_SECONDS * 1000;
  logger.info(`Bot running. Poll interval: ${cm.config.POLL_INTERVAL_SECONDS}s`);

  await runCycle();

  const timer = setInterval(() => {
    runCycle().catch((err) => logger.error("Cycle error", { error: err }));
  }, pollInterval);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    clearInterval(timer);

    const telegram = TelegramService.getInstance();
    telegram.setStatus(BotStatus.IDLE);
    WebSocketManager.getInstance().broadcastStatusChange("IDLE", "Shutting down");

    if (telegram.isEnabled()) {
      await telegram.stop();
    }

    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    logger.info("HTTP server closed");

    await DatabaseService.getInstance().disconnect();
    await QueueManager.getInstance().shutdown();
    await RedisService.getInstance().shutdown();

    logger.info("AstroidBot shut down gracefully");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  logger.error("Fatal startup error", { error });
  process.exit(1);
});
