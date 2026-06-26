import { InlineKeyboard } from "grammy";
import type { BotContext } from "../types.js";
import { DatabaseService } from "../../services/db.js";
import { escapeMd, shortenAddress } from "../utils.js";

export async function walletsScreen(ctx: BotContext): Promise<void> {
  ctx.session.backScreen = "main";
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(telegramId));
  if (!user) return;

  const wallets = await db.findWalletsByUserId(user.id);

  const lines = ["💼 *Your Wallets*\n"];

  if (wallets.length === 0) {
    lines.push("No wallets yet. Create one below.");
  } else {
    wallets.forEach((w, i) => {
      lines.push(`${i + 1}. *${escapeMd(w.name)}*  (#${w.id})`);
      lines.push(`   \`${shortenAddress(w.address)}\``);
      lines.push(`   Balance: ${w.balance.toFixed(2)} STX`);
      lines.push("");
    });
  }

  const keyboard = new InlineKeyboard();

  if (wallets.length > 0) {
    for (const w of wallets) {
      keyboard
        .text(`🔑 ${escapeMd(w.name).slice(0, 14)}${w.name.length > 14 ? "…" : ""}`, `action:reveal_wallet:${w.id}`)
        .row();
    }
  }

  keyboard
    .text("➕ New", "action:create_wallet")
    .text("📥 Import", "action:import_wallet").row()
    .text("🗑 Delete", "action:delete_wallet")
    .text("🔄 Refresh", "action:refresh_wallets").row()
    .text("← Back", "screen:back")
    .text("🏠 Home", "home");

  try {
    await ctx.editMessageText(lines.join("\n"), { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {}
}
