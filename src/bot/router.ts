import type { Bot } from "grammy";
import { logger } from "../utils/logger.js";
import { rateLimiter } from "./middleware/rateLimiter.js";
import { registerCommands } from "./commands.js";
import { handleText } from "./textFlows.js";
import { handleVoice } from "./voice.js";
import { handleCallback, callbackRouteCount } from "./callbacks/index.js";
import type { BotContext } from "../types/bot.js";

export { type BotContext } from "../types/bot.js";

/**
 * Wires the bot's four input surfaces to their handlers.
 *
 * This file was 1,382 lines: command registration, a 250-line `waitingFor`
 * state machine, voice transcription, a 600-line `callback_query:data`
 * if-chain and the natural-language handler all in one scope. The chain's
 * branch *order* was load-bearing and invisible, so adding a route meant
 * reading the whole thing to check nothing above it matched first.
 *
 * Each surface now lives in its own module:
 *   - commands.ts      slash commands and /reveal_N-style shortcuts
 *   - textFlows.ts     the waitingFor state machine
 *   - voice.ts         voice-note transcription
 *   - callbacks/       per-domain route tables behind a dispatcher
 *   - nl.ts            natural-language command handling
 */
export function registerRouter(bot: Bot<BotContext>): void {
  registerCommands(bot);

  bot.on("message:text", rateLimiter, handleText);
  bot.on(":voice", rateLimiter, handleVoice);
  bot.on("callback_query:data", rateLimiter, handleCallback);

  bot.catch((err) => {
    logger.error("Grammy error", { error: err.message });
  });

  const routes = callbackRouteCount();
  logger.info("Bot router registered", {
    exactRoutes: routes.exact,
    prefixRoutes: routes.prefix,
  });
}
