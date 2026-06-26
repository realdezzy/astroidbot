import { InlineKeyboard } from "grammy";
import type { BotContext } from "../types.js";
import { DatabaseService } from "../../services/db.js";
import { escapeMd } from "../utils.js";

export async function tradesScreen(ctx: BotContext): Promise<void> {
  ctx.session.backScreen = "main";
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(telegramId));
  if (!user) return;

  const trades = await db.prisma.trade.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const lines = ["📈 *Recent Trades*\n"];

  if (trades.length === 0) {
    lines.push("No trades yet.");
  } else {
    for (const t of trades) {
      const statusEmoji = t.status === "CONFIRMED" ? "✅" : t.status === "BROADCAST" ? "⏳" : t.status === "FAILED" ? "❌" : "🔄";
      const dir = t.direction === "BUY" ? "🟢" : "🔴";
      lines.push(`${statusEmoji} ${dir} ${t.amountIn.toFixed(2)} ${escapeMd(t.tokenIn)} → ${escapeMd(t.tokenOut)}`);
      lines.push(`   ${t.amountOut > 0 ? `out: ${t.amountOut.toFixed(2)} ${escapeMd(t.tokenOut)} · ` : ""}${t.createdAt.toISOString().slice(0, 16).replace("T", " ")}`);
      lines.push("");
    }
  }

  const keyboard = new InlineKeyboard()
    .text("🔄 Refresh", "action:refresh_trades")
    .text("← Back", "screen:back").row()
    .text("🏠 Home", "home");

  try {
    await ctx.editMessageText(lines.join("\n"), { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {}
}
