import { InlineKeyboard } from "grammy";
import type { BotContext } from "../types.js";
import { BotStatus } from "../../types.js";
import { TelegramService } from "../../services/telegram.js";
import { DatabaseService } from "../../services/db.js";
import { ConfigManager } from "../../config.js";

export async function controlScreen(ctx: BotContext): Promise<void> {
  ctx.session.backScreen = "main";
  const telegram = TelegramService.getInstance();
  const { status, reason } = telegram.getStatus();
  const pollInterval = ConfigManager.getInstance().config.POLL_INTERVAL_SECONDS;
  const db = DatabaseService.getInstance();

  const stats = await db.getStats();

  const statusEmoji =
    status === BotStatus.RUNNING ? "🟢" : status === BotStatus.HALTED ? "🔴" : "⚪";

  const text = [
    "🤖 *Bot Control*",
    "",
    `Status:     ${statusEmoji} *${status}*`,
    `Cycle:      every ${pollInterval}s`,
    `Uptime:     ${Math.floor(process.uptime() / 60)}m ${Math.floor(process.uptime() % 60)}s`,
    ...(reason ? [`Reason:     ${reason}`] : []),
    "",
    "📊 *System Stats*",
    `Users:      ${stats.totalUsers}`,
    `Wallets:    ${stats.totalWallets}`,
    `Trades:     ${stats.totalTrades}`,
  ].join("\n");

  const keyboard = new InlineKeyboard();

  if (status === BotStatus.RUNNING) {
    keyboard.text("🔴 Halt", "action:confirm_halt");
  } else {
    keyboard.text("🟢 Resume", "action:confirm_resume");
  }

  keyboard.text("🔄 Refresh", "action:refresh_control").row()
    .text("📊 Stats", "stats_cmd")
    .text("📢 Broadcast", "broadcast_cmd").row()
    .text("← Back", "screen:back")
    .text("🏠 Home", "home");

  try {
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {
    // message may be too old to edit — silently ignore
  }
}
