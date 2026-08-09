import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../types/bot.js";
import { DatabaseService } from "../../services/db.js";
import { walletDescriptor, groupByChainId } from "../../services/chains/walletChain.js";
import { chainLabel } from "../keyboards/builders.js";
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
    // Grouped by chain, because that is the only grouping a user can act on:
    // a balance on one chain cannot be spent on another. The bot's create and
    // import flows have been chain-first since they were rewritten, but this
    // screen — the one that shows the result — still labelled every balance
    // "STX", so a freshly-created Base wallet read as an empty Stacks one.
    let index = 0;
    for (const [, group] of groupByChainId(wallets)) {
      const descriptor = walletDescriptor(group[0]!);
      lines.push(`*${escapeMd(chainLabel(descriptor))}*`);

      for (const w of group) {
        index++;
        lines.push(`${index}. *${escapeMd(w.name)}*  (#${w.id})${w.isDefault ? " ⭐ (Default)" : ""}`);
        lines.push(`   \`${shortenAddress(w.address)}\``);
        lines.push(`   Balance: ${w.balance.toFixed(2)} ${escapeMd(descriptor.nativeSymbol)}`);
      }
      lines.push("");
    }
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
    .text("⭐ Default", "action:set_default_wallet_list")
    .text("🗑 Delete", "action:delete_wallet").row()
    .text("🔄 Refresh", "action:refresh_wallets")
    .text("← Back", "screen:back").row()
    .text("🏠 Home", "home");

  try {
    await ctx.editMessageText(lines.join("\n"), { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {}
}
