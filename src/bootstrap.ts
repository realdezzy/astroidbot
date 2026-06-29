import type { Server } from "node:http";
import { ConfigManager } from "./config.js";
import { logger } from "./utils/logger.js";
import { DatabaseService } from "./services/db.js";
import { AlexDEXService } from "./services/dex/alex.js";
import { BitflowDEXService } from "./services/dex/bitflow.js";
import { VelarDEXService } from "./services/dex/velar.js";
import { FaktoryDEXService } from "./services/dex/faktory.js";
import { DEXRegistry } from "./services/dex/dexRegistry.js";
import { TelegramService } from "./services/telegram.js";
import { createServer } from "./api/server.js";
import { BotStatus } from "./types.js";


export async function bootstrap(): Promise<Server> {
  logger.info("AstroidBot initializing...");

  // Catch unhandled promise rejections (e.g. from SDK lazy-init)
  process.on("unhandledRejection", (reason) => {
    if (reason instanceof Error && reason.message?.includes("HTTP error! status: 404")) {
      logger.warn("Bitflow SDK initialization failed (404), continuing without Bitflow integration");
      return;
    }
    logger.error("Unhandled rejection", { error: reason instanceof Error ? reason.message : String(reason) });
  });

  ConfigManager.load();

  await DatabaseService.connect();
  const db = DatabaseService.getInstance();
  const healthy = await db.healthCheck();

  if (!healthy) {
    logger.error("Database health check failed. Exiting.");
    logger.error("Prisma migration check: run 'npx prisma migrate dev' or 'npx prisma migrate deploy'");
    process.exit(1);
  }

  try {
    await db.prisma.$queryRaw`SELECT 1 FROM "User" LIMIT 1`;
  } catch {
    logger.warn("User table not found — may need migrations. Run: npx prisma migrate deploy");
  }

  await AlexDEXService.initialize();
  const alex = AlexDEXService.getInstance();
  const tokens = await alex.getSwappableTokens(true);
  logger.info(`Loaded ${tokens.length} ALEX swappable tokens`);

  BitflowDEXService.initialize();
  const bitflow = BitflowDEXService.getInstance();
  bitflow.getPools(true).then((pools) => {
    logger.info(`Loaded ${pools.length} Bitflow pools`);
  }).catch((err) => {
    logger.warn("Bitflow pool prefetch failed", { error: err });
  });

  VelarDEXService.initialize();
  const velar = VelarDEXService.getInstance();
  velar.getSwappableTokens(true).then((vTokens) => {
    logger.info(`Loaded ${vTokens.length} Velar swappable tokens`);
  }).catch((err) => {
    logger.warn("Velar token prefetch failed", { error: err });
  });

  FaktoryDEXService.initialize();
  const faktory = FaktoryDEXService.getInstance();
  faktory.getSwappableTokens(true).then((fTokens) => {
    logger.info(`Loaded ${fTokens.length} Faktory swappable tokens`);
  }).catch((err) => {
    logger.warn("Faktory token prefetch failed", { error: err });
  });

  const registry = DEXRegistry.getInstance();
  registry.registerProvider(bitflow);
  registry.registerProvider(alex);
  registry.registerProvider(velar);
  registry.registerProvider(faktory);

  const httpServer = createServer();

  const telegram = TelegramService.getInstance();

  if (telegram.isEnabled()) {
    await telegram.start();
  }

  telegram.setStatus(BotStatus.RUNNING);

  return httpServer;
}
