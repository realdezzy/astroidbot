import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../types/bot.js";
import { DatabaseService } from "../../services/db.js";
import { DEXRegistry } from "../../services/dex/dexRegistry.js";
import { PortfolioManager } from "../../services/portfolio.js";
import { RiskManager } from "../../services/riskManager.js";
import { escapeMd, shortenAddress } from "../utils.js";

export async function portfolioScreen(ctx: BotContext): Promise<void> {
  ctx.session.backScreen = "main";
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(telegramId));
  if (!user) return;

  const wallets = await db.findWalletsByUserId(user.id);
  if (wallets.length === 0) {
    try {
      await ctx.editMessageText(
        "📊 *Portfolio*\n\nNo wallets found\\.",
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🏠 Home", "home") }
      );
    } catch { }
    return;
  }

  const pm = PortfolioManager.getInstance();
  const tokens = await DEXRegistry.getInstance().getSwappableTokens();

  let allLines = ["📊 *Portfolio*\n"];
  let grandTotal = 0;
  let totalPnl = 0;

  for (const wallet of wallets) {
    const balances = await pm.fetchBalances(wallet.address, tokens, user.id);
    const total = balances.reduce((s, b) => s + b.usdValue, 0);
    grandTotal += total;

    try {
      totalPnl += await RiskManager.getInstance().getDailyPnl(user.id);
    } catch { }

    allLines.push(`*${escapeMd(wallet.name)}*`);
    allLines.push(`\`${shortenAddress(wallet.address)}\``);

    if (balances.length === 0) {
      allLines.push("  _No tokens_");
    } else {
      for (const b of balances.slice(0, 6)) {
        allLines.push(`  ${escapeMd(b.symbol)}  ${b.balance.toFixed(2)}  $${b.usdValue.toFixed(2)}`);
      }
      if (balances.length > 6) {
        allLines.push(`  _...and ${balances.length - 6} more_`);
      }
    }
    allLines.push("");
  }

  const pnlStr = totalPnl >= 0 ? `+${totalPnl.toFixed(2)}` : totalPnl.toFixed(2);
  allLines.push(`*Total:* $${grandTotal.toFixed(2)}`);
  allLines.push(`*24h PnL:* ${pnlStr}`);

  const keyboard = new InlineKeyboard()
    .text("🔄 Refresh", "action:refresh_portfolio")
    .text("← Back", "screen:back").row()
    .text("🏠 Home", "home");

  try {
    await ctx.editMessageText(allLines.join("\n"), { parse_mode: "Markdown", reply_markup: keyboard });
  } catch { }
}
