import { z } from "zod";

export const SentimentSchema = z.object({
  overallSentiment: z.enum(["BULLISH", "BEARISH", "NEUTRAL"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export const PortfolioTargetSchema = z.object({
  token: z.string(),
  targetWeight: z.number(),
});

export const PortfolioSchema = z.object({
  targets: z.array(PortfolioTargetSchema),
});

export const GridSchema = z.object({
  levels: z.number().int().min(3).max(10),
  spreadBps: z.number().int().min(10).max(500),
});

export const ParseCommandSchema = z.object({
  action: z.enum([
    "trade",
    "settings",
    "info",
    "halt",
    "resume",
    "create_strategy",
    "perp_trade",
    "clarify",
    "chat",
    "unknown"
  ]),
}).passthrough();

export const AgentDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("hold"),
    reason: z.string(),
    trade: z.any().optional().nullable(),
  }),
  z.object({
    action: z.literal("trade"),
    reason: z.string(),
    trade: z.object({
      walletId: z.number().optional(),
      tokenIn: z.string().default("STX"),
      tokenOut: z.string(),
      amountIn: z.number().positive(),
      direction: z.enum(["BUY", "SELL"]),
      reason: z.string().optional(),
    }),
  }),
]);
