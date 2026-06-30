import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../types/bot.js";
import { DatabaseService } from "../../services/db.js";
import { escapeMd } from "../utils.js";

export async function agentDetailsScreen(ctx: BotContext, agentId: number): Promise<void> {
  ctx.session.backScreen = "agents";
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(telegramId));
  if (!user) return;

  const agent = await db.prisma.tradeAgent.findUnique({
    where: { id: agentId },
  });

  if (!agent || agent.userId !== user.id) {
    await ctx.reply("❌ Agent not found.");
    return;
  }

  const strategies = await db.prisma.tradingStrategy.findMany({
    where: { agentId: agent.id },
    orderBy: { createdAt: "desc" },
  });

  const state = (agent.state as Record<string, any>) ?? {};
  const lastRun = state.lastRun as string | undefined;
  const lastActions = state.lastActions as number | undefined;
  const lastDecision = state.lastDecision as Record<string, any> | undefined;

  const lines = [
    `🤖 *Agent Details: ${escapeMd(agent.name)}*`,
    `═════════════════════════`,
    `🟢 *Status:* ${agent.isActive ? "Active ✅" : "Paused ⏸"}`,
    `🧠 *AI Mode:* \`${agent.aiMode}\``,
    `🖥️ *Model:* \`${agent.model}\``,
    ``,
    `📊 *Execution Statistics:*`,
    `• Last Run: ${lastRun ? lastRun.slice(0, 16).replace("T", " ") : "Never"}`,
    `• Executed Strategies: \`${state.lastStrategiesExecuted ?? 0}\``,
    `• Executed Actions: \`${lastActions ?? 0}\``,
    lastDecision ? `• Last Decision Reason: _${escapeMd(lastDecision.reason ?? "N/A")}_` : `• Last Decision Reason: _N/A_`,
    ``,
    `📈 *Configured Strategies (${strategies.length}):*`,
  ];

  if (strategies.length === 0) {
    lines.push("   _No strategies configured._");
  } else {
    strategies.forEach((s) => {
      const activeSymbol = s.isActive ? "🟢" : "⏸";
      const configStr = Object.entries(s.config as Record<string, any>)
        .filter(([k]) => k !== "walletIds")
        .map(([k, v]) => `${k}:${v}`)
        .join(", ");
      lines.push(`   ${activeSymbol} *${escapeMd(s.type)}* \\(#${s.id}\\)`);
      lines.push(`     _${escapeMd(configStr)}_`);
    });
  }

  const keyboard = new InlineKeyboard()
    .text(agent.isActive ? "⏸ Pause Agent" : "✅ Activate Agent", `action:agent_toggle_details:${agent.id}`)
    .text("🧠 Set AI Mode", `action:agent_aimode_menu:${agent.id}`)
    .row()
    .text("➕ Add Strategy", `action:strat_add:${agent.id}`)
    .text("🔧 Manage Strategies", `action:agent_strategies_menu:${agent.id}`)
    .row()
    .text("▶ Run Cycle", `action:agent_run_details:${agent.id}`)
    .text("🗑 Delete Agent", `action:agent_delete_details:${agent.id}`)
    .row()
    .text("← Back to Agents", "screen:agents")
    .text("🏠 Home", "home");

  const messageText = lines.join("\n");
  try {
    await ctx.editMessageText(messageText, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {
    await ctx.reply(messageText, { parse_mode: "Markdown", reply_markup: keyboard });
  }
}

export async function agentAiModeMenuScreen(ctx: BotContext, agentId: number): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("📴 Off (Manual)", `action:agent_aimode_set:${agentId}:off`).row()
    .text("💡 Advisor (Suggestions)", `action:agent_aimode_set:${agentId}:advisor`).row()
    .text("🤖 Autonomous (Self-Trading)", `action:agent_aimode_set:${agentId}:autonomous`).row()
    .text("← Back", `action:agent_details:${agentId}`);

  const text = "🧠 *Change Agent AI Decision Mode*\n\nSelect a new mode for the agent:";
  try {
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {}
}

export async function agentStrategiesMenuScreen(ctx: BotContext, agentId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(telegramId));
  if (!user) return;

  const agent = await db.prisma.tradeAgent.findUnique({
    where: { id: agentId },
  });
  if (!agent || agent.userId !== user.id) return;

  const strategies = await db.prisma.tradingStrategy.findMany({
    where: { agentId: agent.id },
    orderBy: { createdAt: "desc" },
  });

  const lines = [
    `🔧 *Manage Strategies for ${escapeMd(agent.name)}*`,
    `═════════════════════════`,
    `Select a strategy to delete or toggle it active/inactive:`,
  ];

  const keyboard = new InlineKeyboard();
  if (strategies.length === 0) {
    lines.push("   _No strategies configured._");
  } else {
    strategies.forEach((s) => {
      const symbol = s.isActive ? "🟢" : "⏸";
      keyboard.text(`${symbol} Toggle #${s.id} (${s.type})`, `action:strat_toggle:${s.id}`).row();
      keyboard.text(`🗑 Delete #${s.id} (${s.type})`, `action:strat_delete:${s.id}`).row();
    });
  }

  keyboard.row()
    .text("➕ Add Strategy", `action:strat_add:${agent.id}`)
    .row()
    .text("← Back to Agent", `action:agent_details:${agent.id}`)
    .text("🏠 Home", "home");

  const text = lines.join("\n");
  try {
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {}
}
