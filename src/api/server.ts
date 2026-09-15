import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Server as HttpServer } from "node:http";
import { ConfigManager } from "../config.js";
import crypto from "node:crypto";
import { logger, loggerStorage } from "../utils/logger.js";
import { AppError, InternalError } from "./errors.js";
import { WebSocketManager } from "./websocket.js";
import { DatabaseService } from "../services/db.js";
import { ChainHealthMonitor } from "../services/chains/chainHealth.js";
import { authenticate, requireAdmin } from "./middleware/auth.js";
import { TelegramService } from "../services/telegram.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/user.js";
import botRoutes from "./routes/bot.js";
import tokenRoutes from "./routes/tokens.js";
import chainRoutes from "./routes/chains.js";
import discoveryRoutes from "./routes/discovery.js";
import limitOrderRoutes from "./routes/limitOrders.js";
import strategiesRoutes from "./routes/strategies.js";
import agentsRoutes from "./routes/agents.js";
import perpRoutes from "./routes/perp/perp.js";
import docsRoutes from "./routes/docs.js";
import contactRoutes from "./routes/contact.js";
import pushRoutes from "./routes/push.js";
import aiRoutes from "./routes/ai.js";
import alertRoutes from "./routes/alerts.js";
import deepLinkRoutes from "./routes/deepLinks.js";
import { QueueManager, QUEUES } from "../services/queue.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createServer(): HttpServer {
  const config = ConfigManager.getInstance().config;
  const app = express();

  app.set("trust proxy", 1);

  app.use((req, res, next) => {
    const correlationId = (req.headers["x-request-id"] as string) || crypto.randomUUID();
    res.setHeader("x-request-id", correlationId);
    const store = new Map<string, string>([["correlationId", correlationId]]);
    loggerStorage.run(store, () => next());
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // No 'unsafe-eval': the dashboard is a Vite production build and has
          // no need for it, and leaving it in removes most of what a CSP is
          // for on a page that renders chain-supplied token names and symbols.
          // 'unsafe-inline' stays only until the remaining inline scripts move
          // to nonces; drop it here once they have.
          scriptSrc: ["'self'", "'unsafe-inline'", "https://telegram.org"],
          frameSrc: ["'self'", "https://oauth.telegram.org", "https://telegram.org"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: [
            "'self'",
            "https://api.hiro.so",
            "https://api.mainnet.hiro.so",
            "https://api.testnet.hiro.so",
            "wss://api.hiro.so",
            "https://api.deepl.com",
            "https://api.deepseek.com",
          ],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: [],
        },
      },
    })
  );

  const corsOrigins = config.CORS_ORIGIN.split(",").map((o) => o.trim());

  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
    })
  );

  app.use(express.json());

  const limiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Too many requests, please try again later",
      code: "RATE_LIMIT_EXCEEDED",
    },
  });
  app.use("/api", limiter);

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many authentication attempts", code: "RATE_LIMIT_EXCEEDED" },
  });

  app.use("/api/auth", authLimiter);

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      uptime: process.uptime(),
      wsClients: WebSocketManager.getInstance().getConnectedCount(),
      telegramBotUsername: ConfigManager.getInstance().config.TELEGRAM_BOT_USERNAME || null,
      chains: ChainHealthMonitor.getInstance().snapshot(),
    });
  });

  /**
   * Per-chain RPC health.
   *
   * Deliberately **not** 503 when a chain is down. This process is serving
   * requests fine; one chain being unreachable is a degraded capability, not a
   * dead instance, and returning 503 would have an orchestrator restart a
   * healthy container over someone else's outage. `degraded: true` is the
   * signal to alert on; the container-level check stays on /api/health.
   */
  app.get("/api/health/chains", (_req: Request, res: Response) => {
    const monitor = ChainHealthMonitor.getInstance();
    res.json({ degraded: monitor.anyUnhealthy(), chains: monitor.snapshot() });
  });

  app.get("/api/health/liveness", (_req: Request, res: Response) => {
    res.status(200).json({ status: "UP" });
  });

  app.get("/api/health/readiness", async (_req: Request, res: Response) => {
    try {
      const db = DatabaseService.getInstance();
      const dbOk = await db.healthCheck();

      let redisOk = false;
      try {
        const queue = QueueManager.getInstance().getQueue(QUEUES.TRADE_EXECUTION);
        const client = await queue.client;
        // BullMQ types `queue.client` as its own connection wrapper; ping is
        // ioredis's and isn't on that type, though it is on the object.
        const pingRes = await (client as unknown as { ping(): Promise<string> }).ping();
        redisOk = pingRes === "PONG";
      } catch (redisErr) {
        logger.error("Redis readiness check failed", { error: (redisErr as Error).message });
      }

      if (dbOk && redisOk) {
        res.status(200).json({ status: "READY", db: "UP", redis: "UP" });
      } else {
        res.status(503).json({
          status: "NOT_READY",
          db: dbOk ? "UP" : "DOWN",
          redis: redisOk ? "UP" : "DOWN"
        });
      }
    } catch (error) {
      logger.error("Readiness check error", { error });
      res.status(503).json({ status: "NOT_READY", error: (error as Error).message });
    }
  });

  app.get("/api/admin/queues", authenticate, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const stats = await QueueManager.getInstance().getQueueStats();
      res.json({ queues: stats });
    } catch (error) {
      logger.error("Failed to fetch queue stats", { error });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const webhookPath = TelegramService.getInstance().getWebhookPath();
  if (webhookPath) {
    app.post(webhookPath, async (req: Request, res: Response) => {
      try {
        await TelegramService.getInstance().handleUpdate(req.body);
        res.sendStatus(200);
      } catch (error) {
        logger.error("Webhook handler error", { error });
        res.sendStatus(500);
      }
    });
    logger.info(`Telegram webhook route registered: POST ${webhookPath}`);
  }

  app.use("/api/auth", authRoutes);
  app.use("/api/contact", contactRoutes);
  app.use("/api", userRoutes);
  app.use("/api/me", limitOrderRoutes);
  app.use("/api/me/strategies", strategiesRoutes);
  app.use("/api/me/agents", agentsRoutes);
  app.use("/api/me/perp", perpRoutes);
  app.use("/api/docs", docsRoutes);
  app.use("/api/push", pushRoutes);
  app.use("/api/me/alerts", alertRoutes);
  app.use("/api/me/deep-links", deepLinkRoutes);


  app.use("/api/ai", aiRoutes);
  app.use("/api/bot", botRoutes);
  app.use("/api", tokenRoutes);
  // Registered AFTER tokenRoutes on purpose: discovery's
  // /tokens/:chainId/:contractId is the same shape as the existing
  // /tokens/:pair/price, and mounting it first would swallow that route with
  // contractId="price".
  app.use("/api", discoveryRoutes);
  app.use("/api", chainRoutes);

  app.use("/api/{*path}", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
  });

  // Resolved from the working directory first, and only then relative to this
  // file. The two differ between running the sources under tsx
  // (src/api/server.ts) and running the build (dist/src/api/server.js), so a
  // purely __dirname-relative path is correct in exactly one of them — and the
  // symptom of getting it wrong is the API serving JSON 404s where the
  // dashboard should be, which reads as a frontend problem.
  const webDistPath = [
    path.resolve(process.cwd(), "web/dist"),
    path.resolve(__dirname, "../../web/dist"),
    path.resolve(__dirname, "../../../web/dist"),
  ].find((candidate) => fs.existsSync(candidate));
  if (webDistPath) {
    app.use(express.static(webDistPath));

    app.get(/.*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(webDistPath, "index.html"));
    });

    logger.info("Serving web dashboard", { path: webDistPath });
  } else {
    app.use((_req: Request, res: Response) => {
      res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    });
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        details: err.details ?? undefined,
      });
      return;
    }

    logger.error("Unhandled error", { error: err.message, stack: err.stack });

    const internal = new InternalError();
    res.status(internal.statusCode).json({
      error: internal.message,
      code: internal.code,
    });
  });

  const server = app.listen(config.PORT, () => {
    logger.info(`API server listening on port ${config.PORT}`);
  });

  WebSocketManager.getInstance().initialize(server);

  return server;
}
