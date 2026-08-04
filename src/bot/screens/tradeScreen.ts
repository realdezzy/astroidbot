import { InlineKeyboard } from "grammy";
import { activeChain, activeChainTokens } from "../chainContext.js";
import { breadcrumb } from "../keyboards/builders.js";
import { walletDescriptor } from "../../services/chains/walletChain.js";
import type { BotContext } from "../../types/bot.js";
import { DatabaseService } from "../../services/db.js";
import { DEXRegistry } from "../../services/dex/dexRegistry.js";
import { escapeMd } from "../utils.js";

/**
 * Symbols offered as one-tap buttons: the chain's native and stable assets
 * first (always tradable, always meaningful), then its most common tokens.
 * Capped at six so the keyboard stays readable on a phone.
 */
async function pickerSymbols(ctx: BotContext): Promise<string[]> {
  const chain = await activeChain(ctx);
  const tokens = await activeChainTokens(ctx);
  const preferred = [chain.nativeSymbol, chain.stableSymbol];
  const rest = tokens
    .map((t) => t.symbol)
    .filter((sym) => !preferred.includes(sym));
  return [...new Set([...preferred, ...rest])].slice(0, 6);
}

export async function tradeScreen(ctx: BotContext, stage?: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(telegramId));
  if (!user) return;

  const wallets = await db.findWalletsByUserId(user.id);
  if (wallets.length === 0) {
    await ctx.reply("💼 No wallets found. Create one first.");
    return;
  }

  if (!stage || stage === "pick_wallet") {
    ctx.session.backScreen = "main";
    if (wallets.length === 1) {
      ctx.session.tradeWalletId = wallets[0]!.id;
      return tradeScreen(ctx, "pick_token_in");
    }

    const keyboard = new InlineKeyboard();
    wallets.forEach((w) => {
      keyboard.text(w.name, `action:trade_wallet_select:${w.id}`).row();
    });
    keyboard.text("🏠 Home", "home");

    const text = "🛒 *Quick Trade - Step 1/5*\n\nSelect the wallet to trade from:";
    try {
      await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
    }
    return;
  }

  if (stage === "pick_token_in") {
    // Built from the active chain's own token list rather than a hardcoded
    // Stacks set, so the picker shows tokens the wallet can actually trade.
    const chain = await activeChain(ctx);
    const keyboard = new InlineKeyboard();
    for (const [i, symbol] of (await pickerSymbols(ctx)).entries()) {
      keyboard.text(symbol, `action:trade_token_in_select:${symbol}`);
      if ((i + 1) % 2 === 0) keyboard.row();
    }
    keyboard.row()
      .text("🔍 Enter Custom Token Symbol", "action:trade_token_in_custom")
      .row()
      .text("🏠 Home", "home");

    const text =
      `${breadcrumb(chain)}🛒 *Quick Trade - Step 2/5*\n\nSelect the token you want to *SPEND* (Token In):`;
    try {
      await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
    }
    return;
  }

  if (stage === "pick_token_out") {
    const chain = await activeChain(ctx);
    const tokenIn = ctx.session.tradeTokenIn ?? chain.nativeSymbol;
    const keyboard = new InlineKeyboard();

    let placed = 0;
    for (const symbol of await pickerSymbols(ctx)) {
      if (symbol === tokenIn) continue;
      keyboard.text(symbol, `action:trade_token_out_select:${symbol}`);
      if (++placed % 2 === 0) keyboard.row();
    }
    keyboard.row();
    keyboard.text("🔍 Enter Custom Token Symbol", "action:trade_token_out_custom").row()
      .text("🏠 Home", "home");

    const text = `${breadcrumb(chain)}🛒 *Quick Trade - Step 3/5*\n\nToken In: *${escapeMd(tokenIn)}*\n\nSelect the token you want to *RECEIVE* (Token Out):`;
    try {
      await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
    }
    return;
  }

  if (stage === "enter_amount") {
    ctx.session.waitingFor = "trade_amount_custom";
    const chain = await activeChain(ctx);
    const tokenIn = ctx.session.tradeTokenIn ?? chain.nativeSymbol;
    const tokenOut = ctx.session.tradeTokenOut ?? chain.stableSymbol;

    const text = `🛒 *Quick Trade - Step 4/5*\n\nSwap: *${escapeMd(tokenIn)}* → *${escapeMd(tokenOut)}*\n\nEnter the amount of *${escapeMd(tokenIn)}* to spend:\n\nType /cancel to abort.`;
    const keyboard = new InlineKeyboard().text("❌ Cancel", "action:cancel_session");
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
    return;
  }

  if (stage === "confirm") {
    const defaultWallet = wallets.find((w) => w.isDefault) ?? wallets[0]!;
    const walletId = ctx.session.tradeWalletId ?? defaultWallet.id;
    const wallet = wallets.find((w) => w.id === walletId) ?? defaultWallet;
    const walletChain = walletDescriptor(wallet);
    const tokenIn = ctx.session.tradeTokenIn ?? walletChain.nativeSymbol;
    const tokenOut = ctx.session.tradeTokenOut ?? walletChain.stableSymbol;
    const rawAmount = ctx.session.tradeAmount;
    const amount = typeof rawAmount === "number" ? rawAmount : parseFloat(String(rawAmount ?? "0"));

    if (amount <= 0) {
      await ctx.reply("❌ Invalid amount. Let's start over.");
      return tradeScreen(ctx, "pick_wallet");
    }

    const waitMsg = await ctx.reply("🔍 Resolving quote and routes from DEX providers...");

    try {
      const bestQuoteResult = await DEXRegistry.getInstance().getBestQuote(tokenIn, tokenOut, amount);
      if (ctx.chat) {
        try { await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch { }
      }

      if (!bestQuoteResult) {
        await ctx.reply(`❌ No trading route found for *${escapeMd(tokenIn)}* → *${escapeMd(tokenOut)}* on any DEX. Please try different tokens.`, { parse_mode: "Markdown" });
        return tradeScreen(ctx, "pick_wallet");
      }

      const { providerName, quote: est } = bestQuoteResult;
      const rate = est.amountOut / amount;

      const text = [
        `🛒 *Confirm Trade - Step 5/5*`,
        `═════════════════════════`,
        `🟢 *Direction:* Swap ${escapeMd(tokenIn)} → ${escapeMd(tokenOut)}`,
        `💼 *Wallet:* ${escapeMd(wallet.name)} (\`${wallet.address.slice(0, 8)}...\`)`,
        `DEX: \`${providerName}\``,
        ``,
        `*Swap Details:*`,
        `• Spend: *${amount.toFixed(4)} ${escapeMd(tokenIn)}*`,
        `• Receive: *~${est.amountOut.toFixed(4)} ${escapeMd(tokenOut)}*`,
        `• Exchange Rate: \`1 ${tokenIn} = ${rate.toFixed(4)} ${tokenOut}\``,
        `• Price Impact: \`${est.priceImpact.toFixed(2)}%\``,
        `• DEX Fee: \`${est.feeAmount.toFixed(4)} ${escapeMd(tokenIn)}\` (${est.feeBps} bps)`,
      ].join("\n");

      const keyboard = new InlineKeyboard()
        .text("✅ Confirm Swap", "action:trade_confirm_elite")
        .row()
        .text("🔄 Start Over", "action:trade_restart")
        .text("🏠 Home", "home");

      await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (err) {
      if (ctx.chat) {
        try { await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch { }
      }
      const reason = err instanceof Error ? err.message : "Unknown error";
      await ctx.reply(`❌ Quote calculation failed: ${reason}.`);
      return tradeScreen(ctx, "pick_wallet");
    }
    return;
  }
}
