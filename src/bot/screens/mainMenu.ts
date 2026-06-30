import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../types/bot.js";
import { BotStatus } from "../../types.js";
import { TelegramService } from "../../services/telegram.js";
import { DatabaseService } from "../../services/db.js";
import { ConfigManager } from "../../config.js";
import { escapeMd } from "../utils.js";

export async function mainMenu(ctx: BotContext): Promise<void> {
  ctx.session.backScreen = undefined;
  const telegram = TelegramService.getInstance();
  const { status } = telegram.getStatus();
  const pollInterval = ConfigManager.getInstance().config.POLL_INTERVAL_SECONDS;
  const db = DatabaseService.getInstance();

  const statusEmoji = status === BotStatus.RUNNING ? "🟢" : status === BotStatus.HALTED ? "🔴" : "⚪";

  const telegramId = BigInt(ctx.from?.id ?? 0);
  const user = telegramId ? await db.findUserByTelegramId(telegramId) : null;

  const wallets = user ? await db.findWalletsByUserId(user.id) : [];
  const totalBalance = wallets.reduce((s, w) => s + w.balance, 0);
  const orders = user ? await db.prisma.limitOrder.count({ where: { userId: user.id, status: "ACTIVE" } }) : 0;
  const strategiesCount = user
    ? await db.prisma.tradingStrategy.count({ where: { userId: user.id, isActive: true } })
    : 0;

  const displayName = ctx.from?.first_name ?? user?.username ?? "trader";

  const lines = [
    `🤖 *AstroidBot*`,
    "",
    user ? `Welcome, *${escapeMd(displayName)}*!` : "Welcome to AstroidBot!",
    "",
    `Status: ${statusEmoji} *${status}*  ·  cycle: ${pollInterval}s`,
    `Portfolio: $${totalBalance.toFixed(2)}${user ? `  ·  ⭐ ${user.points}pts` : ""}`,
    `💼 ${wallets.length} wallet(s)  ·  📋 ${orders} orders  ·  🧠 ${strategiesCount} strategies`,
  ];

  if (user && !user.email) {
    lines.push("", "⚠️ *Email not linked* — tap Email button below");
  }

  const text = lines.join("\n");

  const keyboard = new InlineKeyboard()
    .text("📊 Portfolio", "screen:portfolio")
    .text("💼 Wallets", "screen:wallets")
    .row()
    .text("📈 Trades", "screen:trades")
    .text("📋 Limit Orders", "screen:orders")
    .row()
    .text("🛒 Quick Trade", "screen:trade")
    .text("🤖 Agents", "screen:agents")
    .row()
    .text("⚙️ Settings", "screen:settings")
    .text(user?.email ? "📧 Email ✓" : "📧 Link Email", user?.email ? "action:noop" : "action:link_email_start");

  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard }); } catch {}
  } else {
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
  }
}
