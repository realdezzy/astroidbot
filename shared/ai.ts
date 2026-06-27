import type { AiMode, AIAction, AIContext } from "./types.js";

export const AI_MODES: readonly AiMode[] = ["off", "advisor", "autonomous"] as const;
export const AI_ACTIONS: readonly AIAction[] = ["trade", "info", "settings", "halt", "resume", "create_strategy", "chat", "unknown"] as const;
export const AI_CONTEXTS: readonly AIContext[] = ["sentiment", "portfolio", "market_making", "parse_command"] as const;

export const AI_CACHE_TTL: Record<string, number> = {
  sentiment: 900,
  portfolio: 900,
  market_making: 1800,
  parse_command: 300,
};
