import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { logger } from "../utils/logger.js";
import { ConfigManager } from "../config.js";
import { DatabaseService } from "../services/db.js";
import { TelegramService } from "../services/telegram.js";
import { BotStatus } from "../types.js";
import { adminGuard } from "./middleware/adminGuard.js";
import { rateLimiter } from "./middleware/rateLimiter.js";
import { escapeMd } from "./utils.js";
import { isAdmin } from "./context.js";
import { mainMenu } from "./screens/mainMenu.js";
import { portfolioScreen } from "./screens/portfolioScreen.js";
import { walletsScreen } from "./screens/walletsScreen.js";
import { ordersScreen } from "./screens/ordersScreen.js";
import { settingsScreen } from "./screens/settingsScreen.js";
import { tradeScreen } from "./screens/tradeScreen.js";
import { tradesScreen } from "./screens/tradesScreen.js";
import { agentsScreen, runAgent, toggleAgent, setAgentAiMode, deleteAgent } from "./screens/agentsScreen.js";
import type { BotContext } from "../types/bot.js";

/** Slash commands and `/reveal_N`-style text shortcuts. */
export function registerCommands(bot: Bot<BotContext>): void {

  bot.command("start", rateLimiter, async (ctx) => {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    if (!telegramId) return;
    const db = DatabaseService.getInstance();
    let user = await db.findUserByTelegramId(telegramId);
    if (!user) {
      user = await db.createUser({ telegramId, username: ctx.from?.username });
      logger.info("New user registered", { telegramId: telegramId.toString() });
      try { await (await import("../services/wallet.js")).provisionDefaultWallet(user.id); } catch { }
      if (ConfigManager.getInstance().config.DRY_RUN) {
        try { await db.markEmailVerified(user.id); } catch { }
      }
    }
    await mainMenu(ctx);
  });

  bot.command("help", rateLimiter, async (ctx) => {
    let text = [
      "🆘 *Commands*",
      "",
      "/start — Main menu",
      "/trade — Quick token swap",
      "/portfolio — View holdings",
      "/wallets — Manage wallets",
      "/trades — Recent trade history",
      "/orders — Limit orders",
      "/agents — AI trading agents",
      "/settings — Risk/slippage config",
      "/link\\_email — Connect email",
      "/ai — AI assistant",
      "/help — This list",
      "/cancel — Abort any flow",
    ].join("\n");
    if (isAdmin(ctx)) {
      text += [
        "", "",
        "🔐 *Admin*",
        "/halt /resume /stats /users /user /disable /enable /points /broadcast",
      ].join("\n");
    }
    await ctx.reply(text, { parse_mode: "Markdown" });
  });

  bot.command("halt", adminGuard, rateLimiter, async (ctx) => {
    TelegramService.getInstance().setStatus(BotStatus.HALTED, "Admin halt via /halt");
    await ctx.reply("🛑 Trading halted.");
  });

  bot.command("resume", adminGuard, rateLimiter, async (ctx) => {
    TelegramService.getInstance().setStatus(BotStatus.RUNNING);
    await ctx.reply("✅ Trading resumed.");
  });

  bot.command("stats", adminGuard, rateLimiter, async (ctx) => {
    const s = await DatabaseService.getInstance().getStats();
    await ctx.reply(
      `📊 *System Stats*\n\nUsers: ${s.totalUsers}\nWallets: ${s.totalWallets}\nTrades: ${s.totalTrades}\nUptime: ${Math.floor(process.uptime() / 60)}m`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("users", adminGuard, rateLimiter, async (ctx) => {
    const users = await DatabaseService.getInstance().getAllUsers(1, 10);
    if (users.length === 0) return ctx.reply("No users.");
    await ctx.reply(
      users.map(u => `${u.id}. ${u.isActive ? "✅" : "❌"} ${u.username ?? u.email ?? "N/A"} | ${u.points}pts`).join("\n"),
      { parse_mode: "Markdown" }
    );
  });

  bot.command("user", adminGuard, rateLimiter, async (ctx) => {
    const uid = parseInt(ctx.match?.trim() ?? "", 10);
    if (isNaN(uid)) return ctx.reply("Usage: /user <id>");
    const u = await DatabaseService.getInstance().findUserById(uid);
    if (!u) return ctx.reply("Not found.");
    await ctx.reply(`👤 #${u.id} | ${u.username ?? "N/A"} | Email: ${u.email ?? "N/A"} | Points: ${u.points} | Active: ${u.isActive ? "✅" : "❌"}`);
  });

  bot.command("disable", adminGuard, rateLimiter, async (ctx) => {
    const uid = parseInt(ctx.match?.trim() ?? "", 10);
    if (isNaN(uid)) return ctx.reply("Usage: /disable <id>");
    await DatabaseService.getInstance().setUserActive(uid, false);
    await ctx.reply(`❌ User #${uid} disabled.`);
  });

  bot.command("enable", adminGuard, rateLimiter, async (ctx) => {
    const uid = parseInt(ctx.match?.trim() ?? "", 10);
    if (isNaN(uid)) return ctx.reply("Usage: /enable <id>");
    await DatabaseService.getInstance().setUserActive(uid, true);
    await ctx.reply(`✅ User #${uid} enabled.`);
  });

  bot.command("points", adminGuard, rateLimiter, async (ctx) => {
    const parts = ctx.match?.trim().split(/\s+/);
    if (!parts || parts.length < 2) return ctx.reply("Usage: /points <id> <amount>");
    await DatabaseService.getInstance().addPoints(parseInt(parts[0]!, 10), parseInt(parts[1]!, 10));
    await ctx.reply("⭐ Done.");
  });

  bot.command("broadcast", adminGuard, rateLimiter, async (ctx) => {
    const msg = ctx.match?.trim();
    if (!msg) return ctx.reply("Usage: /broadcast <message>");
    const users = await DatabaseService.getInstance().getUsersWithTelegram();
    let sent = 0;
    for (const u of users) {
      try { await ctx.api.sendMessage(Number(u.telegramId), `📢 ${msg}`); sent++; } catch { }
    }
    await ctx.reply(`📢 Sent to ${sent}/${users.length}.`);
  });

  bot.command("link_email", rateLimiter, async (ctx) => {
    const tid = BigInt(ctx.from?.id ?? 0);
    if (!tid) return;
    const user = await DatabaseService.getInstance().findUserByTelegramId(tid);
    if (!user) return ctx.reply("Please /start first.");
    if (user.email) return ctx.reply(`Your account is linked to: *${escapeMd(user.email)}*`, { parse_mode: "Markdown" });
    const keyboard = new InlineKeyboard()
      .text("📧 Enter Email", "action:link_email_start")
      .text("🏠 Home", "home");
    await ctx.reply("📧 *Link Email*\n\nYour Telegram account isn't linked to an email yet.\nClick below to connect one:", {
      parse_mode: "Markdown", reply_markup: keyboard,
    });
  });

  bot.command("cancel", rateLimiter, async (ctx) => {
    ctx.session.waitingFor = null;
    delete ctx.session.emailToLink;
    delete ctx.session.emailOtp;
    delete ctx.session.emailOtpExpiry;
    delete ctx.session.tradePair;
    delete ctx.session.tradeDir;
    delete ctx.session.tradeAmount;
    delete ctx.session.limitPair;
    delete ctx.session.limitDir;
    delete ctx.session.limitAmount;
    delete ctx.session.limitPrice;
    delete ctx.session.tempPrivateKey;
    delete ctx.session.tempAddress;
    await ctx.reply("❌ Cancelled. Type /start for main menu.");
  });

  bot.command("trade", rateLimiter, async (ctx) => { await tradeScreen(ctx, "pick_pair"); });
  bot.command("portfolio", rateLimiter, async (ctx) => { await portfolioScreen(ctx); });
  bot.command("wallets", rateLimiter, async (ctx) => { await walletsScreen(ctx); });
  bot.command("trades", rateLimiter, async (ctx) => { await tradesScreen(ctx); });
  bot.command("orders", rateLimiter, async (ctx) => { await ordersScreen(ctx); });
  bot.command("agents", rateLimiter, async (ctx) => { await agentsScreen(ctx); });
  bot.command("settings", rateLimiter, async (ctx) => { await settingsScreen(ctx); });
  bot.command("ai", rateLimiter, async (ctx) => {
    await agentsScreen(ctx);
  });

  // ════════════════════ Hears Patterns ════════════════════

  bot.hears(/^\/link[_-]?email$/i, rateLimiter, async (ctx) => {
    const tid = BigInt(ctx.from?.id ?? 0);
    if (!tid) return;
    const user = await DatabaseService.getInstance().findUserByTelegramId(tid);
    if (!user) return ctx.reply("Please /start first.");
    if (user.email) return ctx.reply(`Your account is linked to: *${escapeMd(user.email)}*`, { parse_mode: "Markdown" });
    ctx.session.waitingFor = "link_email";
    await ctx.reply("📧 Enter your email address:");
  });

  bot.hears(/^\/cancel_(\d+)$/, rateLimiter, async (ctx) => {
    const orderId = ctx.match?.[1];
    if (orderId) await ordersScreen(ctx, orderId);
  });

  bot.hears(/^\/reveal_(\d+)$/, rateLimiter, async (ctx) => {
    return ctx.reply(
      "❌ *Security Protection*\n\nFor your security, private keys cannot be revealed or displayed within Telegram chats. Please log in to the secure Web Dashboard and navigate to the `/wallets` page to view your keys.",
      { parse_mode: "Markdown" }
    );
  });

  // Agent shortcuts: /run_1, /toggle_2, /del_3, /aimode_1_advisor
  bot.hears(/^\/run_(\d+)$/, rateLimiter, async (ctx) => {
    const agentId = parseInt(ctx.match?.[1] ?? "", 10);
    if (isNaN(agentId)) return;
    await runAgent(ctx, agentId);
  });

  bot.hears(/^\/toggle_(\d+)$/, rateLimiter, async (ctx) => {
    const agentId = parseInt(ctx.match?.[1] ?? "", 10);
    if (isNaN(agentId)) return;
    await toggleAgent(ctx, agentId);
  });

  bot.hears(/^\/del_(\d+)$/, rateLimiter, async (ctx) => {
    const agentId = parseInt(ctx.match?.[1] ?? "", 10);
    if (isNaN(agentId)) return;
    await deleteAgent(ctx, agentId);
  });

  bot.hears(/^\/aimode_(\d+)_(\w+)$/, rateLimiter, async (ctx) => {
    const agentId = parseInt(ctx.match?.[1] ?? "", 10);
    const mode = ctx.match?.[2] ?? "";
    if (isNaN(agentId) || !["off", "advisor", "autonomous"].includes(mode)) return;
    await setAgentAiMode(ctx, agentId, mode);
  });
}
