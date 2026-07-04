import type { Server } from "node:http";
import https from "node:https";
import axios from "axios";
import { ConfigManager } from "./config.js";
import { logger } from "./utils/logger.js";
import { DatabaseService } from "./services/db.js";
import { AlexDEXService } from "./services/dex/alex.js";
import { BitflowDEXService } from "./services/dex/bitflow.js";
import { VelarDEXService } from "./services/dex/velar.js";
import { DEXRegistry } from "./services/dex/dexRegistry.js";
import { TelegramService } from "./services/telegram.js";
import { createServer } from "./api/server.js";
import { BotStatus } from "./types.js";


export async function bootstrap(): Promise<Server> {
  logger.info("AstroidBot initializing...");

  // Configure global Axios defaults to prevent Cloudflare/CDN TLS handshake blocking (alert 40)
  axios.defaults.httpsAgent = new https.Agent({
    ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384",
    honorCipherOrder: true,
    minVersion: "TLSv1.2",
  });
  axios.defaults.headers.common["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

  const registry = DEXRegistry.getInstance();
  registry.registerProvider(bitflow);
  registry.registerProvider(alex);
  registry.registerProvider(velar);

  const httpServer = createServer();

  const telegram = TelegramService.getInstance();

  if (telegram.isEnabled()) {
    await telegram.start();
  }

  telegram.setStatus(BotStatus.RUNNING);

  return httpServer;
}
