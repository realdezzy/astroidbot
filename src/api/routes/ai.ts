import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import OpenAI, { toFile } from "openai";
import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { authenticate } from "../middleware/auth.js";
import { AIOrchestrator } from "../../services/ai.js";

/**
 * Natural-language and voice entry points to the trading engine.
 *
 * These were defined inline in `createServer` among the route mounts, which
 * made them the only endpoints in the codebase without a module — and hid the
 * fact that they were sharing the general API rate limit. A Whisper
 * transcription and a `GET /api/chains` had the same budget, on endpoints
 * where each request costs real money at a third party.
 */
const router = express.Router();

/**
 * Tighter than the general limiter, and per user rather than per IP.
 *
 * Both routes below spend money at an external provider on every call, so the
 * thing worth bounding is what one account can spend, not what one address
 * can. Falls back to IP for the (unreachable) unauthenticated case.
 */
const aiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.userId ? `user:${req.userId}` : req.ip ?? "unknown"),
  message: {
    error: "Too many AI requests, please slow down",
    code: "RATE_LIMIT_EXCEEDED",
  },
});

/**
 * Transcription client, built once.
 *
 * Constructed per request before, which meant a new HTTPS agent and connection
 * pool for every voice command rather than a reused one.
 */
let openai: OpenAI | null = null;

function transcriptionClient(): OpenAI | null {
  const apiKey = ConfigManager.getInstance().config.OPENAI_API_KEY;
  // The placeholder from .env.example counts as absent — it produces a 401
  // from OpenAI that reads like an outage rather than like a missing setting.
  if (!apiKey || apiKey.startsWith("sk-...")) return null;

  if (!openai) openai = new OpenAI({ apiKey });
  return openai;
}

/** Test seam: the client is module state and would leak between suites. */
export function resetAiClient(): void {
  openai = null;
}

type ChatHistory = { role: "user" | "assistant"; content: string }[];

/** POST /api/ai/command — parse a natural-language trading instruction. */
router.post("/command", authenticate, aiLimiter, async (req: Request, res: Response) => {
  try {
    const { input, history } = req.body as { input: string; history?: ChatHistory };
    if (!input?.trim()) return res.status(400).json({ error: "input is required" });

    const parsed = await AIOrchestrator.getInstance().parseCommand(
      req.userId!,
      input.trim(),
      history
    );
    if (!parsed) return res.json({ action: "unknown", reason: "Failed to parse" });

    res.json(parsed);
  } catch (error) {
    logger.error("AI command failed", { error });
    res.status(500).json({ error: "Internal error" });
  }
});

/** POST /api/ai/voice — transcribe audio, then parse it as a command. */
router.post(
  "/voice",
  authenticate,
  aiLimiter,
  express.raw({ type: "audio/*", limit: "10mb" }),
  async (req: Request, res: Response) => {
    try {
      const buffer = req.body as Buffer;
      if (!buffer || buffer.length === 0) {
        return res.status(400).json({ error: "Audio data is required" });
      }

      const client = transcriptionClient();
      if (!client) {
        return res.status(503).json({ error: "Voice commands are not configured on this deployment." });
      }

      const fileObj = await toFile(buffer, "voice.webm", { type: "audio/webm" });

      const transcription = await client.audio.transcriptions.create({
        file: fileObj,
        model: "whisper-1",
      });

      const transcriptionText = transcription.text.trim();
      if (!transcriptionText) {
        return res.json({ text: "", parsed: null, error: "Could not hear or understand audio." });
      }

      let history: ChatHistory | undefined;
      const historyQuery = req.query.history as string | undefined;
      if (historyQuery) {
        try {
          history = JSON.parse(historyQuery) as ChatHistory;
        } catch {
          // Malformed history is not worth failing the command over; the
          // parser treats its absence as a fresh conversation.
        }
      }

      const parsed = await AIOrchestrator.getInstance().parseCommand(
        req.userId!,
        transcriptionText,
        history
      );

      res.json({ text: transcriptionText, parsed });
    } catch (error) {
      logger.error("AI voice command failed", { error });
      res.status(500).json({ error: "Internal error" });
    }
  }
);

export default router;
