import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../types/bot.js";
import { DatabaseService } from "../../services/db.js";
import { LimitOrderService } from "../../services/limitOrder.js";
import { DEXRegistry } from "../../services/dex/dexRegistry.js";
import { escapeMd } from "../utils.js";

export async function ordersScreen(ctx: BotContext, cancelId?: string): Promise<void> {
  ctx.session.backScreen = "main";
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(telegramId));
  if (!user) return;

  const service = LimitOrderService.getInstance();

  if (cancelId) {
    await service.cancel(parseInt(cancelId, 10));
  }

  const orders = await service.getActive(user.id);

  const lines = ["📋 *Limit Orders*\n"];

  if (orders.length === 0) {
    lines.push("No active orders.");
  } else {
    lines.push(`_${orders.length} active_\n`);
    orders.forEach((o, i) => {
      lines.push(`${i + 1}. ${o.direction === "BUY" ? "🟢 BUY" : "🔴 SELL"} ${escapeMd(o.tokenOut)}`);
      lines.push(`   ${o.amountIn.toFixed(4)} ${escapeMd(o.tokenIn)} @ $${o.targetPrice.toFixed(4)}`);
      lines.push("");
    });
  }

  const keyboard = new InlineKeyboard();

  for (const o of orders) {
    keyboard.text(
      `❌ ${o.direction === "BUY" ? "BUY" : "SELL"} ${escapeMd(o.tokenOut).slice(0, 10)}`,
      `action:cancel_order:${o.id}`
    ).row();
  }

  keyboard
    .text("➕ Create", "action:limit_create_pair")
    .text("🔄 Refresh", "action:refresh_orders").row()
    .text("← Back", "screen:back")
    .text("🏠 Home", "home");

  try {
    await ctx.editMessageText(lines.join("\n"), { parse_mode: "Markdown", reply_markup: keyboard });
  } catch { }
}

export async function limitCreateScreen(ctx: BotContext, stage?: string): Promise<void> {
  const registry = DEXRegistry.getInstance();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const db = DatabaseService.getInstance();
  const user = telegramId ? await db.findUserByTelegramId(BigInt(telegramId)) : null;
  const wallets = user ? await db.findWalletsByUserId(user.id) : [];
  if (!user || wallets.length === 0) {
    await ctx.reply("No wallets found.");
    return;
  }

  const pair = (ctx.session.limitPair as string) ?? "STX/sUSDT";
  const [tknIn, tknOut] = pair.split("/");
  const tokenIn = tknIn ?? "STX";
  const tokenOut = tknOut ?? "sUSDT";
  const dir = (ctx.session.limitDir as string) ?? "BUY";
  const rawAmount = ctx.session.limitAmount;
  const amount = typeof rawAmount === "number" ? rawAmount : parseFloat(String(rawAmount ?? "0"));

  const payToken = dir === "BUY" ? tokenIn : tokenOut;
  const receiveToken = dir === "BUY" ? tokenOut : tokenIn;

  // Stage 1: Pick token
  if (!stage || stage === "pick_pair") {
    const tokens = registry.getCachedTokens();
    const top16 = tokens.slice(0, 16);
    const keyboard = new InlineKeyboard();
    for (let i = 0; i < top16.length; i += 2) {
      keyboard.text(top16[i]?.symbol ?? "", `action:limit_token:${top16[i]?.symbol ?? ""}`);
      if (top16[i + 1]) keyboard.text(top16[i + 1]?.symbol ?? "", `action:limit_token:${top16[i + 1]?.symbol ?? ""}`);
      keyboard.row();
    }
    keyboard.row().text("🏠 Home", "home");
    const text = "📋 *New Limit Order*\n\nSelect the token you want to buy/sell:";
    try { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard }); } catch {
      await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
    }
    return;
  }

  // Stage 2: Direction
  if (stage === "pick_direction") {
    const keyboard = new InlineKeyboard()
      .text(`🟢 BUY ${escapeMd(tokenOut)}`, "action:limit_dir:BUY")
      .text(`🔴 SELL ${escapeMd(tokenOut)}`, "action:limit_dir:SELL").row()
      .text("🔄 Change Token", "action:limit_create_pair")
      .text("🏠 Home", "home");
    const text = `📋 *New Limit Order — ${escapeMd(pair)}*\n\nPick direction:`;
    try { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard }); } catch { }
    return;
  }

  // Stage 3: Enter amount
  if (stage === "enter_amount") {
    ctx.session.waitingFor = "limit_amount";
    const kb = new InlineKeyboard().text("❌ Cancel", "action:cancel_session");
    await ctx.reply(`📋 *${dir} ${escapeMd(tokenOut)}*\n\nEnter amount in *${escapeMd(payToken)}*:`, {
      parse_mode: "Markdown", reply_markup: kb,
    });
    return;
  }

  // Stage 4: Enter target price
  if (stage === "enter_price") {
    ctx.session.waitingFor = "limit_price";
    const kb = new InlineKeyboard().text("❌ Cancel", "action:cancel_session");
    await ctx.reply(`📋 *${dir} ${escapeMd(tokenOut)}*\n\nAmount: ${amount} ${escapeMd(payToken)}\n\nEnter target price (USD):`, {
      parse_mode: "Markdown", reply_markup: kb,
    });
    return;
  }

  // Stage 5: Confirm
  if (stage === "confirm") {
    const rawPrice = ctx.session.limitPrice;
    const targetPrice = typeof rawPrice === "number" ? rawPrice : parseFloat(String(rawPrice ?? "0"));
    const text = [
      `📋 *Confirm Limit Order*`,
      ``,
      `${dir === "BUY" ? "🟢 BUY" : "🔴 SELL"} ${escapeMd(tokenOut)}`,
      `Amount:   ${amount} ${escapeMd(payToken)}`,
      `Price:    $${targetPrice.toFixed(4)}`,
      `Wallet:   ${escapeMd(wallets[0]!.name)}`,
    ].join("\n");

    const keyboard = new InlineKeyboard()
      .text("✅ Place Order", "action:limit_confirm")
      .row()
      .text("🔄 Start Over", "action:limit_create_pair")
      .text("🏠 Home", "home");

    try { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard }); } catch { }
    return;
  }

  return limitCreateScreen(ctx, "pick_pair");
}
