import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../types/bot.js";
import { DatabaseService } from "../../services/db.js";
import { escapeMd } from "../utils.js";
import { markdownView, renderScreen } from "../ui/render.js";

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

  const state = (agent.state as Record<string, unknown>) ?? {};
  const lastRun = state.lastRun as string | undefined;
  const lastActions = state.lastActions as number | undefined;
  const lastDecision = state.lastDecision as Record<string, unknown> | undefined;

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
    lastDecision ? `• Last Decision Reason: _${escapeMd(String(lastDecision.reason ?? "N/A"))}_` : `• Last Decision Reason: _N/A_`,
    ``,
    `📈 *Configured Strategies (${strategies.length}):*`,
  ];

  if (strategies.length === 0) {
    lines.push("   _No strategies configured._");
  } else {
    strategies.forEach((s) => {
      const activeSymbol = s.isActive ? "🟢" : "⏸";
      const configStr = Object.entries(s.config as Record<string, unknown>)
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
    .text("📋 Reports", `action:agent_reports:${agent.id}`)
    .row()
    .text("🗑 Delete Agent", `action:agent_delete_details:${agent.id}`)
    .row()
    .text("← Back to Agents", "screen:agents")
    .text("🏠 Home", "home");

  const messageText = lines.join("\n");
  await renderScreen(ctx, markdownView(messageText, keyboard));
}

export async function agentReportsScreen(ctx: BotContext, agentId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(telegramId));
  const agent = user ? await db.prisma.tradeAgent.findFirst({ where: { id: agentId, userId: user.id } }) : null;
  if (!user || !agent) return void await ctx.reply("❌ Agent not found.");

  const reports = await db.prisma.agentDecision.findMany({
    where: { userId: user.id, agentId },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const lines = [`📋 *${escapeMd(agent.name)} — Decision Reports*`, "═════════════════════════"];
  if (reports.length === 0) {
    lines.push("No cycles have been reported yet. Run the agent once to generate its first report.");
  } else {
    for (const report of reports) {
      const icon = report.outcome === "EXECUTED" ? "✅" : report.outcome === "FAILED" ? "❌" : report.outcome === "SUPPRESSED" ? "🛡" : "⏸";
      const risk = report.expectedRisk as Record<string, unknown>;
      lines.push(
        "",
        `${icon} *${report.outcome.replaceAll("_", " ")}* · ${report.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
        escapeMd(report.explanation),
        report.triggeredRule ? `Rule: _${escapeMd(report.triggeredRule.slice(0, 240))}_` : "Rule: _No trade rule triggered_",
        `Risk: max position ${escapeMd(String(risk.maxPositionPct ?? "—"))}% · slippage ${escapeMd(String(risk.slippageBps ?? "—"))} bps`,
        report.confidence == null ? "" : `Confidence: ${(report.confidence * 100).toFixed(0)}%`,
      );
    }
  }

  const keyboard = new InlineKeyboard()
    .text(agent.isActive ? "⏸ Pause Agent" : "✅ Activate Agent", `action:agent_toggle_details:${agent.id}`)
    .text("▶ Run Cycle", `action:agent_run_details:${agent.id}`)
    .row()
    .text("← Agent", `action:agent_details:${agent.id}`)
    .text("🏠 Home", "home");
  await renderScreen(ctx, markdownView(lines.filter(Boolean).join("\n"), keyboard));
}

export async function agentAiModeMenuScreen(ctx: BotContext, agentId: number): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("📴 Off (Manual)", `action:agent_aimode_set:${agentId}:off`).row()
    .text("💡 Advisor (Suggestions)", `action:agent_aimode_set:${agentId}:advisor`).row()
    .text("🤖 Autonomous (Self-Trading)", `action:agent_aimode_set:${agentId}:autonomous`).row()
    .text("← Back", `action:agent_details:${agentId}`);

  const text = "🧠 *Change Agent AI Decision Mode*\n\nSelect a new mode for the agent:";
  await renderScreen(ctx, markdownView(text, keyboard));
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
  await renderScreen(ctx, markdownView(text, keyboard));
}
