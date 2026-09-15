import { InlineKeyboard } from "grammy";
import { DatabaseService } from "../services/db.js";
import { TelegramService } from "../services/telegram.js";
import { BotStatus } from "../types.js";
import { isAdmin } from "./context.js";
import { screenMap } from "./context.js";
import { ConfigManager } from "../config.js";
import { walletDescriptor } from "../services/chains/walletChain.js";
import { activeChain } from "./chainContext.js";
import { setActiveChain } from "./chainContext.js";
import { tradeScreen } from "./screens/tradeScreen.js";
import type { BotContext } from "../types/bot.js";
import { Prisma } from "@prisma/client";

export async function handleNLCommand(ctx: BotContext, text: string): Promise<void> {
  const tid = BigInt(ctx.from?.id ?? 0);
  if (!tid) return;
  const user = await DatabaseService.getInstance().findUserByTelegramId(tid);
  if (!user) return;

  if (!ctx.session.chatHistory) {
    ctx.session.chatHistory = [];
  }
  const history = ctx.session.chatHistory.slice(-6);

  await ctx.replyWithChatAction("typing").catch(() => undefined);
  const ai = (await import("../services/ai.js")).AIOrchestrator.getInstance();
  const parsed = await ai.parseCommand(user.id, text, history);

  ctx.session.chatHistory.push({ role: "user", content: text });

  if (!parsed || parsed.action === "unknown") {
    const greetingRegex = /^(hello|hi|hey|greetings|good morning|good afternoon|good evening|yo)\b/i;
    if (greetingRegex.test(text)) {
      // Examples follow the user's active chain, so a Base user isn't shown a
      // pair their wallet cannot route.
      const chain = await activeChain(ctx);
      const pair = `${chain.nativeSymbol} for ${chain.stableSymbol}`;
      const reply = "👋 *Hello!* I am AstroidBot, your AI multichain trading assistant.\n\n" +
        "I can help you with:\n" +
        `• *Trades*: e.g. \`buy 10 ${pair}\`\n` +
        "• *Automated strategies*: DCA, Grid, and Portfolio Rebalancing\n" +
        "• *Wallets*: e.g. `show my wallets` or create/import wallets\n" +
        "• *Limit Orders*: e.g. `open limit orders`\n\n" +
        "Ask me anything or use the buttons below to navigate!";
      ctx.session.chatHistory.push({ role: "assistant", content: reply });
      ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
      await ctx.reply(reply, { parse_mode: "Markdown" });
      return;
    }
    const chain = await activeChain(ctx);
    const fallback = "🤖 *AstroidBot Assistant*\n\n" +
      "I didn't quite catch that. Here are some things I can do for you:\n" +
      `• *Swaps*: \`buy 10 ${chain.nativeSymbol}\`, \`sell 5 ${chain.stableSymbol}\`\n` +
      "• *Risk Limits*: `set slippage 200`\n" +
      "• *View Panels*: `show portfolio`, `list wallets`, `open orders`\n" +
      "• *Strategies*: `create rebalance strategy`\n\n" +
      "Type /help to see all commands.";
    ctx.session.chatHistory.push({ role: "assistant", content: fallback });
    ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
    await ctx.reply(fallback, { parse_mode: "Markdown" });
    return;
  }

  const action = parsed.action as string;

  if (action === "chat") {
    const replyText = (parsed.replyText as string) || "How can I help you today?";
    const suggestedLink = parsed.suggestedLink as string | undefined;
    const suggestedScreen = parsed.suggestedScreen as string | undefined;

    ctx.session.chatHistory.push({ role: "assistant", content: replyText });
    ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);

    let kb: InlineKeyboard | undefined;
    if (suggestedLink) {
      const corsOrigin = ConfigManager.getInstance().config.CORS_ORIGIN || "http://localhost:5173";
      const linkUrl = corsOrigin.endsWith("/") && suggestedLink.startsWith("/")
        ? `${corsOrigin}${suggestedLink.slice(1)}`
        : `${corsOrigin}${suggestedLink}`;
      kb = new InlineKeyboard().url("🌐 Open Web Page", linkUrl);
    }

    if (kb) {
      await ctx.reply(replyText, { parse_mode: "Markdown", reply_markup: kb });
    } else {
      await ctx.reply(replyText, { parse_mode: "Markdown" });
    }

    if (suggestedScreen && screenMap[suggestedScreen]) return screenMap[suggestedScreen](ctx);
    return;
  }

  if (action === "trade") {
    const t = (parsed.trade as Record<string, unknown> | undefined) ?? (parsed.tokenIn ? parsed : undefined);
    if (!t) return;
    const wallets = await DatabaseService.getInstance().findWalletsByUserId(user.id);
    const wallet = wallets.find(w => w.isDefault) ?? wallets[0];
    if (!wallet) {
      const reply = "No wallet found.";
      ctx.session.chatHistory.push({ role: "assistant", content: reply });
      ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
      await ctx.reply(reply);
      return;
    }

    // Defaults come from the wallet's own chain. Defaulting to STX/USDCx for a
    // Base or Solana wallet produces a trade with no route on any provider.
    const aiChain = walletDescriptor(wallet);
    const aiTokenIn = (t.tokenIn as string) ?? aiChain.nativeSymbol;
    const aiTokenOut = (t.tokenOut as string) ?? aiChain.stableSymbol;

    const amount = Number(t.amountIn ?? 1);
    if (!Number.isFinite(amount) || amount <= 0) {
      await ctx.reply("❌ I could not determine a valid trade amount. Try again with an amount, such as `swap 10 USDC to ETH`.", { parse_mode: "Markdown" });
      return;
    }

    // Natural language may prepare a trade, but moving funds always goes
    // through the same quote preview and explicit confirmation as button flow.
    setActiveChain(ctx, aiChain.chainId);
    ctx.session.tradeWalletId = wallet.id;
    ctx.session.tradeTokenIn = aiTokenIn;
    ctx.session.tradeTokenOut = aiTokenOut;
    ctx.session.tradeAmount = amount;
    delete ctx.session.tradeQuote;

    const reply = `I prepared this swap on ${aiChain.displayName}. Review the live route and confirm below.`;
    ctx.session.chatHistory.push({ role: "assistant", content: reply });
    ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
    await ctx.reply(reply);
    return tradeScreen(ctx, "confirm");
  }

  if (action === "info") {
    const topic = parsed.topic as string;
    const reply = `Opening your ${topic} screen.`;
    ctx.session.chatHistory.push({ role: "assistant", content: reply });
    ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);

    const screen = screenMap[topic === "status" ? "settings" : topic];
    if (screen) return screen(ctx);
  }

  if (action === "settings") {
    const key = parsed.key as string;
    const value = parsed.value as string | number | boolean;
    if (!key || value === undefined) return;
    const db = DatabaseService.getInstance();
    const s = await db.findTradeSettings(user.id, "personal");
    await db.upsertTradeSettings({
      userId: user.id, context: "personal",
      slippageBps: key === "slippageBps" ? Number(value) : s?.slippageBps,
      maxPositionPct: key === "maxPositionPct" ? Number(value) : s?.maxPositionPct,
      dailyLossLimit: key === "dailyLossLimit" ? Number(value) : s?.dailyLossLimit,
      rebalanceThreshold: key === "rebalanceThreshold" ? Number(value) : s?.rebalanceThreshold,
      useGasless: key === "useGasless" ? (value === true || value === "true" || value === 1 || value === "enabled") : s?.useGasless,
      gaslessFeeToken: key === "gaslessFeeToken" ? String(value) : s?.gaslessFeeToken,
    });
    const reply = `✅ ${key} set to ${value}`;
    ctx.session.chatHistory.push({ role: "assistant", content: reply });
    ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
    await ctx.reply(reply);
    return;
  }

  if (action === "halt") {
    if (isAdmin(ctx)) {
      TelegramService.getInstance().setStatus(BotStatus.HALTED, `Admin halt via NL command: ${text}`);
      const reply = "🛑 Trading halted.";
      ctx.session.chatHistory.push({ role: "assistant", content: reply });
      ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
      await ctx.reply(reply);
    } else {
      const reply = "❌ Only administrators can halt the trading engine.";
      ctx.session.chatHistory.push({ role: "assistant", content: reply });
      ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
      await ctx.reply(reply);
    }
    return;
  }

  if (action === "resume") {
    if (isAdmin(ctx)) {
      TelegramService.getInstance().setStatus(BotStatus.RUNNING);
      const reply = "✅ Trading resumed.";
      ctx.session.chatHistory.push({ role: "assistant", content: reply });
      ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
      await ctx.reply(reply);
    } else {
      const reply = "❌ Only administrators can resume the trading engine.";
      ctx.session.chatHistory.push({ role: "assistant", content: reply });
      ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
      await ctx.reply(reply);
    }
    return;
  }

  if (action === "create_strategy") {
    const type = parsed.type as string;
    const config = parsed.config as Prisma.InputJsonValue;
    if (!type || !config) return;
    const db = DatabaseService.getInstance();
    await db.prisma.tradingStrategy.create({
      data: {
        userId: user.id,
        type,
        config,
        isActive: true,
      }
    });
    const reply = `✅ Trading strategy *${type}* created successfully via AI.`;
    ctx.session.chatHistory.push({ role: "assistant", content: reply });
    ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
    await ctx.reply(reply, { parse_mode: "Markdown" });
    return;
  }
}
