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
import { authenticate, requireAdmin } from "./middleware/auth.js";
import { TelegramService } from "../services/telegram.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/user.js";
import botRoutes from "./routes/bot.js";
import tokenRoutes from "./routes/tokens.js";
import limitOrderRoutes from "./routes/limitOrders.js";
import strategiesRoutes from "./routes/strategies.js";
import agentsRoutes from "./routes/agents.js";
import perpRoutes from "./routes/perp/perp.js";
import docsRoutes from "./routes/docs.js";
import contactRoutes from "./routes/contact.js";
import { QueueManager, QUEUES } from "../services/queue.js";
import { AIOrchestrator } from "../services/ai.js";
import OpenAI, { toFile } from "openai";


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
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
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
    });
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
        const pingRes = await (client as any).ping();
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


  app.post("/api/ai/command", authenticate, async (req: Request, res: Response) => {
    try {
      const { input, history } = req.body as { input: string; history?: { role: "user" | "assistant"; content: string }[] };
      if (!input?.trim()) return res.status(400).json({ error: "input is required" });
 
      const parsed = await AIOrchestrator.getInstance().parseCommand(req.userId!, input.trim(), history);
      if (!parsed) return res.json({ action: "unknown", reason: "Failed to parse" });
 
      res.json(parsed);
    } catch (error) {
      logger.error("AI command failed", { error });
      res.status(500).json({ error: "Internal error" });
    }
  });
 
  app.post("/api/ai/voice", authenticate, express.raw({ type: "audio/*", limit: "10mb" }), async (req: Request, res: Response) => {
    try {
      const buffer = req.body as Buffer;
      if (!buffer || buffer.length === 0) {
        return res.status(400).json({ error: "Audio data is required" });
      }
 
      const openaiApiKey = ConfigManager.getInstance().config.OPENAI_API_KEY;
      if (!openaiApiKey || openaiApiKey.startsWith("sk-...")) {
        return res.status(500).json({ error: "OpenAI API key is not configured." });
      }
 
      const openai = new OpenAI({ apiKey: openaiApiKey });
      const fileObj = await toFile(buffer, "voice.webm", { type: "audio/webm" });
 
      const transcription = await openai.audio.transcriptions.create({
        file: fileObj,
        model: "whisper-1",
      });
 
      const transcriptionText = transcription.text.trim();
      if (!transcriptionText) {
        return res.json({ text: "", parsed: null, error: "Could not hear or understand audio." });
      }
 
      const historyQuery = req.query.history as string | undefined;
      let history: { role: "user" | "assistant"; content: string }[] | undefined;
      if (historyQuery) {
        try {
          history = JSON.parse(historyQuery);
        } catch {}
      }

      const parsed = await AIOrchestrator.getInstance().parseCommand(req.userId!, transcriptionText, history);
 
      res.json({
        text: transcriptionText,
        parsed
      });
    } catch (error) {
      logger.error("AI voice command failed", { error });
      res.status(500).json({ error: "Internal error" });
    }
  });
  app.use("/api/bot", botRoutes);
  app.use("/api", tokenRoutes);

  const webDistPath = path.resolve(__dirname, "../../web/dist");
  if (fs.existsSync(webDistPath)) {
    app.use(express.static(webDistPath));

    app.get(/.*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(webDistPath, "index.html"));
    });

    logger.info("Serving web dashboard from web/dist");
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
