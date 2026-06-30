import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../types/bot.js";
import { DatabaseService } from "../../services/db.js";

export async function settingsScreen(ctx: BotContext, toggle?: string): Promise<void> {
  ctx.session.backScreen = "main";
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(telegramId));
  if (!user) return;

  let settings = await db.findTradeSettings(user.id, "personal");
  if (!settings) {
    settings = await db.upsertTradeSettings({ userId: user.id, context: "personal" });
  }

  // Handle toggle actions
  if (toggle) {
    const [field, dir] = toggle.split(":");
    const updates: Record<string, () => void> = {
      "slippage_up": () => {
        settings!.slippageBps = Math.min(1000, (settings?.slippageBps ?? 100) + 50);
      },
      "slippage_down": () => {
        settings!.slippageBps = Math.max(10, (settings?.slippageBps ?? 100) - 50);
      },
      "maxpos_up": () => {
        settings!.maxPositionPct = Math.min(100, (settings?.maxPositionPct ?? 25) + 5);
      },
      "maxpos_down": () => {
        settings!.maxPositionPct = Math.max(1, (settings?.maxPositionPct ?? 25) - 5);
      },
      "loss_up": () => {
        settings!.dailyLossLimit = Math.min(25, (settings?.dailyLossLimit ?? 5) + 1);
      },
      "loss_down": () => {
        settings!.dailyLossLimit = Math.max(0.5, (settings?.dailyLossLimit ?? 5) - 1);
      },
      "thresh_up": () => {
        settings!.rebalanceThreshold = Math.min(10, (settings?.rebalanceThreshold ?? 2) + 0.5);
      },
      "thresh_down": () => {
        settings!.rebalanceThreshold = Math.max(0.5, (settings?.rebalanceThreshold ?? 2) - 0.5);
      },
      "gasless_toggle": () => {
        settings!.useGasless = !settings!.useGasless;
      },
    };

    const combo = `${field}_${dir}`;
    if (updates[combo]) {
      updates[combo]();
      await db.upsertTradeSettings({
        userId: user.id,
        context: "personal",
        slippageBps: settings.slippageBps,
        maxPositionPct: settings.maxPositionPct,
        dailyLossLimit: settings.dailyLossLimit,
        rebalanceThreshold: settings.rebalanceThreshold,
        useGasless: settings.useGasless,
      });
    }
  }

  const s = settings!;
  const text = [
    "⚙️ *Trade Settings*",
    "",
    `Slippage:     ${s.slippageBps} bps`,
    `Max Position: ${s.maxPositionPct}%`,
    `Daily Loss:   ${s.dailyLossLimit}%`,
    `Rebalance:    ${s.rebalanceThreshold}%`,
    `VelumX Gasless: ${s.useGasless ? "🟢 Enabled" : "🔴 Disabled"}`,
  ].join("\n");

  const keyboard = new InlineKeyboard()
    .text("◀ Slp", "action:toggle_settings:slippage:down")
    .text(`${s.slippageBps} bps`, "action:noop")
    .text("Slp ▶", "action:toggle_settings:slippage:up")
    .row()
    .text("◀ Pos", "action:toggle_settings:maxpos:down")
    .text(`${s.maxPositionPct}%`, "action:noop")
    .text("Pos ▶", "action:toggle_settings:maxpos:up")
    .row()
    .text("◀ Loss", "action:toggle_settings:loss:down")
    .text(`${s.dailyLossLimit}%`, "action:noop")
    .text("Loss ▶", "action:toggle_settings:loss:up")
    .row()
    .text("◀ Rebal", "action:toggle_settings:thresh:down")
    .text(`${s.rebalanceThreshold}%`, "action:noop")
    .text("Rebal ▶", "action:toggle_settings:thresh:up")
    .row()
    .text(s.useGasless ? "Disable Gasless" : "Enable Gasless", "action:toggle_settings:gasless:toggle")
    .row()
    .text("← Back", "screen:back")
    .text("🏠 Home", "home");

  try {
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {
    // silent
  }
}
