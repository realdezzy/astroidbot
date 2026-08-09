import { ConfigManager } from "../config.js";
import { DatabaseService } from "../services/db.js";
import { mainMenu } from "./screens/mainMenu.js";
import { portfolioScreen } from "./screens/portfolioScreen.js";
import { walletsScreen } from "./screens/walletsScreen.js";
import { ordersScreen } from "./screens/ordersScreen.js";
import { settingsScreen } from "./screens/settingsScreen.js";
import { controlScreen } from "./screens/controlScreen.js";
import { tradeScreen } from "./screens/tradeScreen.js";
import { tradesScreen } from "./screens/tradesScreen.js";
import { agentsScreen } from "./screens/agentsScreen.js";
import type { BotContext } from "../types/bot.js";

/** Shared helpers for the bot's callback and text handlers. */

export function isAdmin(ctx: BotContext): boolean {
  const adminIds = ConfigManager.getInstance().telegramAdminIds;
  return adminIds.includes(BigInt(ctx.from?.id ?? 0));
}

/** Refuses a non-admin and answers the callback. True when the caller may proceed. */
export async function requireAdmin(ctx: BotContext): Promise<boolean> {
  if (isAdmin(ctx)) return true;
  await ctx.answerCallbackQuery({ text: "🔒 Admin only", show_alert: true });
  return false;
}

export const screenMap: Record<string, (ctx: BotContext) => Promise<void>> = {
  main: mainMenu,
  portfolio: portfolioScreen,
  wallets: walletsScreen,
  orders: ordersScreen,
  settings: settingsScreen,
  control: controlScreen,
  trade: tradeScreen,
  trades: tradesScreen,
  agents: agentsScreen,
};

/**
 * The Telegram user's AstroidBot account, or null.
 *
 * Nearly every handler opened with the same four lines to get here; having it
 * once means the `BigInt(ctx.from?.id ?? 0)` conversion can't drift between
 * call sites.
 */
export async function currentUser(ctx: BotContext) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return null;
  return DatabaseService.getInstance().findUserByTelegramId(BigInt(telegramId));
}
