import crypto from "node:crypto";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { ConfigManager } from "../config.js";
import { logger } from "../utils/logger.js";
import { DatabaseService } from "./db.js";
import { RedisService } from "./redis.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { PortfolioManager } from "./portfolio.js";
import { RiskManager } from "./riskManager.js";
import type {
  PortfolioTarget,
  GridSpreadConfig,
  AISentimentResult,
  TokenBalance,
} from "../types.js";

// Prompts, schemas, and intent helper imports
import { buildParseCommandPrompt } from "./ai/prompts/parseCommand.js";
import { buildSentimentPrompt } from "./ai/prompts/sentiment.js";
import { buildPortfolioPrompt } from "./ai/prompts/portfolio.js";
import { buildGridPrompt } from "./ai/prompts/grid.js";
import {
  SentimentSchema,
  PortfolioSchema,
  GridSchema,
  ParseCommandSchema,
} from "./ai/schemas.js";
import { needsPortfolioContext } from "./ai/intent.js";

const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o",
  deepseek: "deepseek-chat",
  google: "gemini-1.5-flash",
};

interface AIRequest<T> {
  task: string;
  prompt: string;
  schema: z.ZodType<T>;
  userId: number;
  cacheTTL?: number;
  metadata?: Record<string, unknown>;
}

export class AIOrchestrator {
  private static instance: AIOrchestrator;
  private openaiClient: OpenAI | null = null;
  private deepseekClient: OpenAI | null = null;
  private googleClient: GoogleGenerativeAI | null = null;
  private readonly provider: string;
  private readonly model: string;

  private constructor() {
    const config = ConfigManager.getInstance().config;

    this.provider = config.AI_PROVIDER;
    this.model = config.AI_MODEL;

    if (config.OPENAI_API_KEY) {
      this.openaiClient = new OpenAI({ apiKey: config.OPENAI_API_KEY });
    }

    if (config.DEEPSEEK_API_KEY) {
      this.deepseekClient = new OpenAI({
        apiKey: config.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com/v1",
      });
    }

    if (config.GOOGLE_AI_API_KEY) {
      this.googleClient = new GoogleGenerativeAI(config.GOOGLE_AI_API_KEY);
    }
  }

  static getInstance(): AIOrchestrator {
    if (!AIOrchestrator.instance) {
      AIOrchestrator.instance = new AIOrchestrator();
    }
    return AIOrchestrator.instance;
  }

  /**
   * Unified request handler for LLM interactions.
   * Leverages caching, model routing, schema validation, and provider failover.
   */
  async request<T>(req: AIRequest<T>): Promise<T> {
    const inputHash = crypto.createHash("sha256").update(req.prompt).digest("hex");
    // Versioned cache key to prevent stale responses after prompt changes
    const cacheKey = `llm:v1:${req.task}:${inputHash}`;
    const cacheTtl = req.cacheTTL ?? 600;

    const redis = RedisService.getInstance();
    if (cacheTtl > 0) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          logger.info("LLM cache hit", { task: req.task, hash: inputHash.slice(0, 8) });
          const parsed = JSON.parse(cached);
          const validated = req.schema.parse(parsed);
          return validated;
        }
      } catch (err) {
        logger.warn("Failed to retrieve or validate cached LLM response", { error: err });
      }
    }

    // Provider failover sequence: try primary first, then others
    const providers = [this.provider];
    if (this.provider !== "openai") providers.push("openai");
    if (this.provider !== "deepseek") providers.push("deepseek");
    if (this.provider !== "google") providers.push("google");

    let responseText = "";
    let finalProvider = "";
    let finalModel = "";
    let promptTokens = 0;
    let completionTokens = 0;

    for (const p of providers) {
      try {
        if (p === "openai" && this.openaiClient) {
          finalModel = p === this.provider ? this.model : (DEFAULT_MODELS.openai ?? "gpt-4o");
          const completion = await this.openaiClient.chat.completions.create({
            model: finalModel,
            messages: [
              {
                role: "system",
                content: "You are a Stacks blockchain trading bot. Respond only in valid JSON.",
              },
              { role: "user", content: req.prompt },
            ],
            temperature: 0.3,
            response_format: { type: "json_object" as const },
          });
          responseText = completion.choices[0]?.message?.content ?? "";
          promptTokens = completion.usage?.prompt_tokens ?? 0;
          completionTokens = completion.usage?.completion_tokens ?? 0;
          finalProvider = "openai";
          break;
        }

        if (p === "deepseek" && this.deepseekClient) {
          finalModel = p === this.provider ? this.model : (DEFAULT_MODELS.deepseek ?? "deepseek-chat");
          const completion = await this.deepseekClient.chat.completions.create({
            model: finalModel,
            messages: [
              {
                role: "system",
                content: "You are a Stacks blockchain trading bot. Respond only in valid JSON.",
              },
              { role: "user", content: req.prompt },
            ],
            temperature: 0.3,
          });
          responseText = completion.choices[0]?.message?.content ?? "";
          promptTokens = completion.usage?.prompt_tokens ?? 0;
          completionTokens = completion.usage?.completion_tokens ?? 0;
          finalProvider = "deepseek";
          break;
        }

        if (p === "google" && this.googleClient) {
          finalModel = p === this.provider ? this.model : (DEFAULT_MODELS.google ?? "gemini-1.5-flash");
          const geminiModel = this.googleClient.getGenerativeModel({
            model: finalModel,
            generationConfig: {
              responseMimeType: "application/json",
            },
          });
          const result = await geminiModel.generateContent(req.prompt);
          responseText = result.response.text();
          promptTokens = 0;
          completionTokens = 0;
          finalProvider = "google";
          break;
        }
      } catch (err) {
        logger.warn(`AI provider failover active — failed: ${p}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!responseText) {
      throw new Error("All AI providers failed or returned empty response");
    }

    const cleanedJsonStr = extractJson(responseText);
    const parsedObj = JSON.parse(cleanedJsonStr);
    const validated = req.schema.parse(parsedObj);

    // Save recommendation to database asynchronously
    this.saveRecommendation(req.userId, req.task, inputHash, {
      provider: finalProvider,
      model: finalModel,
      promptTokens,
      completionTokens,
      response: responseText,
    }).catch((err) => {
      logger.warn("Asynchronous save recommendation failed", { error: err });
    });

    if (cacheTtl > 0) {
      redis.set(cacheKey, JSON.stringify(validated), cacheTtl).catch((err) => {
        logger.warn("Failed to cache LLM response in Redis", { error: err });
      });
    }

    return validated;
  }

  /**
   * Legacy method for compatiblity. Executes request with z.any() validation.
   */
  async callLLM(
    userId: number,
    context: string,
    prompt: string
  ): Promise<string> {
    const res = await this.request({
      task: context,
      prompt,
      schema: z.any(),
      userId,
      cacheTTL: context.startsWith("agent-") ? 600 : 0,
    });
    return typeof res === "string" ? res : JSON.stringify(res);
  }

  async parseCommand(
    userId: number,
    input: string,
    history?: { role: "user" | "assistant"; content: string }[]
  ): Promise<Record<string, unknown> | null> {
    let userContextStr = "";

    // Intent classification: skip costly DB queries & balance fetches for simple chats/greetings
    if (needsPortfolioContext(input)) {
      try {
        const db = DatabaseService.getInstance();
        const wallets = await db.findWalletsByUserId(userId);
        if (wallets.length > 0) {
          const tokens = await DEXRegistry.getInstance().getSwappableTokens();

          let grandTotal = 0;
          let totalPnl = 0;
          const walletDetails: string[] = [];

          for (const wallet of wallets) {
            const balances = await PortfolioManager.getInstance().fetchBalances(wallet.address, tokens, userId);
            const total = balances.reduce((s, b) => s + b.usdValue, 0);
            grandTotal += total;

            const tokenDetails = balances
              .map(b => `${b.symbol}: ${b.balance.toFixed(4)} ($${b.usdValue.toFixed(2)})`)
              .join(", ");
            walletDetails.push(
              `- Wallet "${wallet.name}" (${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}): Total $${total.toFixed(2)}. Holdings: [${tokenDetails || "No tokens"}]`
            );
          }

          try {
            totalPnl = await RiskManager.getInstance().getDailyPnl(userId);
          } catch { }

          userContextStr = `
User Portfolio/Wallet Context:
- Active Wallets: ${wallets.length}
- Grand Total Balance across all wallets: $${grandTotal.toFixed(2)}
- 24h PnL (profit/loss today): $${totalPnl.toFixed(2)}
Wallet Breakdown:
${walletDetails.join("\n")}
`;
        } else {
          userContextStr = `\nUser Portfolio/Wallet Context:\n- The user has no wallets configured yet.\n`;
        }
      } catch (e) {
        logger.error("Failed to build user context for parseCommand", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    } else {
      logger.info("Simple command intent detected — skipping portfolio fetches", { input });
    }

    let historyStr = "";
    if (history && history.length > 0) {
      historyStr =
        "\nRecent Conversation History:\n" +
        history.map(h => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`).join("\n") +
        "\n";
    }

    const prompt = buildParseCommandPrompt(userContextStr, historyStr, input);
    try {
      return await this.request({
        task: "parse_command",
        prompt,
        schema: ParseCommandSchema,
        userId,
        cacheTTL: 300,
      }) as Record<string, unknown>;
    } catch (e) {
      logger.warn("Failed to parse command response", { error: e });
      return null;
    }
  }

  async parseVoiceTranscript(
    userId: number,
    transcript: string,
    history?: { role: "user" | "assistant"; content: string }[]
  ): Promise<Record<string, unknown> | null> {
    return this.parseCommand(userId, transcript, history);
  }

  async analyzeSentiment(
    userId: number,
    tokenSymbols: string[],
    recentPriceData: Record<string, number[]>
  ): Promise<AISentimentResult> {
    const prompt = buildSentimentPrompt(tokenSymbols, recentPriceData);
    try {
      const result = await this.request({
        task: "sentiment",
        prompt,
        schema: SentimentSchema,
        userId,
        cacheTTL: 900,
      });
      return {
        ...result,
        timestamp: new Date(),
      };
    } catch (e) {
      logger.warn("Sentiment analysis failed — falling back to neutral defaults", { error: e });
      return {
        overallSentiment: "NEUTRAL",
        confidence: 0.3,
        reasoning: "Failover default due to parsing error",
        timestamp: new Date(),
      };
    }
  }

  async generatePortfolioTargets(
    userId: number,
    currentBalances: TokenBalance[],
    sentiment: AISentimentResult
  ): Promise<PortfolioTarget[]> {
    const prompt = buildPortfolioPrompt(currentBalances, sentiment);
    try {
      const result = await this.request({
        task: "portfolio",
        prompt,
        schema: PortfolioSchema,
        userId,
        cacheTTL: 900,
      });

      const targets = result.targets;
      if (targets.length === 0) {
        return this.equalWeightTargets(currentBalances);
      }

      const totalWeight = targets.reduce((sum, t) => sum + (t.targetWeight ?? 0), 0);
      if (Math.abs(totalWeight - 1.0) > 0.01) {
        logger.warn("Portfolio weights don't sum to 1.0 — normalizing weights", { totalWeight });
        return targets.map((t) => ({
          token: t.token,
          targetWeight: t.targetWeight / totalWeight,
        }));
      }

      return targets;
    } catch (e) {
      logger.warn("Portfolio target generation failed — falling back to equal weights", { error: e });
      return this.equalWeightTargets(currentBalances);
    }
  }

  async generateGridSpreads(
    userId: number,
    tokenPair: string,
    volatility: number,
    currentMidPrice: number
  ): Promise<GridSpreadConfig> {
    const prompt = buildGridPrompt(tokenPair, volatility, currentMidPrice);
    try {
      const result = await this.request({
        task: "market_making",
        prompt,
        schema: GridSchema,
        userId,
        cacheTTL: 1800,
      });
      return {
        tokenPair,
        midPrice: currentMidPrice,
        levels: Math.min(10, Math.max(3, result.levels)),
        spreadBps: Math.min(500, Math.max(10, result.spreadBps)),
      };
    } catch (e) {
      logger.warn("Grid spreads configuration generation failed — falling back to defaults", { error: e });
      return {
        tokenPair,
        midPrice: currentMidPrice,
        levels: 5,
        spreadBps: 30,
      };
    }
  }

  private async saveRecommendation(
    userId: number,
    context: string,
    inputHash: string,
    data: {
      provider: string;
      model: string;
      promptTokens: number;
      completionTokens: number;
      response: string;
    }
  ): Promise<void> {
    try {
      await DatabaseService.getInstance().createAIRecommendation({
        userId,
        context,
        inputHash,
        modelProvider: data.provider,
        modelName: data.model,
        promptTokens: data.promptTokens,
        completionTokens: data.completionTokens,
        recommendation: JSON.parse(extractJson(data.response)),
      });
    } catch {
      logger.warn("Failed to save AI recommendation", {
        context,
        provider: data.provider,
      });
    }
  }

  private equalWeightTargets(balances: TokenBalance[]): PortfolioTarget[] {
    if (balances.length === 0) return [];
    const weight = 1.0 / balances.length;
    return balances.map((b) => ({ token: b.symbol, targetWeight: weight }));
  }
}

function extractJson(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return cleaned.slice(start, end + 1);
  }
  return cleaned;
}
