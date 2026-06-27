import { InlineKeyboard } from "grammy";
import type { BotContext } from "../types.js";
import { DatabaseService } from "../../services/db.js";
import { AgentService } from "../../services/agentService.js";
import { escapeMd } from "../utils.js";

const STRATEGY_FIELDS: Record<string, string[]> = {
  portfolio_rebalance: ["rebalanceThreshold", "maxPositionPct", "useAI", "aiRefreshMinutes", "maxSlippageBps", "tokenUniverse", "minTradeUsd"],
  grid: ["tokenPair", "levels", "spreadBps", "maxPositionPct", "useAI", "aiRefreshMinutes", "gridRangePct", "totalCapitalUsd"],
  dca: ["tokenIn", "tokenOut", "amount", "intervalMinutes", "priceCondition", "priceThresholdUsd", "maxSlippageBps", "totalBudgetUsd"],
  sniper: ["watchTokens", "maxBuyAmount", "perTokenCapUsd", "maxPriceImpactPct", "slippageBps", "cooldownMinutes"],
  copy: ["targetAddress", "maxPerTrade", "maxCopiesPerCycle", "copyRatio", "delaySeconds"],
  momentum: ["lookbackPeriods", "momentumThresholdPct", "exitThresholdPct", "positionSizeUsd", "tokenUniverse"],
  mean_reversion: ["maPeriods", "entryDeviationPct", "exitDeviationPct", "tokenPair", "positionSizeUsd"],
  twap: ["tokenIn", "tokenOut", "totalAmount", "slices", "windowMinutes", "maxSlippageBps"],
  stop_loss_tp: ["token", "takeProfitPct", "stopLossPct", "trailingStopPct"],
  rotational: ["topK", "rebalancePeriodHours", "positionSizeUsd", "tokenUniverse"],
  breakout: ["lookbackPeriods", "breakoutPct", "tokenPair", "positionSizeUsd"],
};

const STRATEGY_LABELS: Record<string, string> = {
  rebalanceThreshold: "Rebalance Threshold (%)",
  maxPositionPct: "Max Position (%)",
  useAI: "Use AI? (true/false)",
  aiRefreshMinutes: "AI Refresh Interval (min)",
  maxSlippageBps: "Max Slippage (bps)",
  tokenUniverse: "Token Universe (CSV, e.g. STX,ALEX)",
  minTradeUsd: "Min Trade Size ($)",
  tokenPair: "Token Pair (e.g. STX/sUSDT)",
  levels: "Grid Levels (e.g. 5)",
  spreadBps: "Spread (bps)",
  gridRangePct: "Grid Range (%)",
  totalCapitalUsd: "Total Capital ($)",
  tokenIn: "Source Token (e.g. STX)",
  tokenOut: "Destination Token (e.g. sUSDT)",
  amount: "Amount per Buy (e.g. 1.0)",
  intervalMinutes: "Interval (min)",
  priceCondition: "Price Cond (always/below/above)",
  priceThresholdUsd: "Price Threshold ($)",
  totalBudgetUsd: "Total Budget (0=unlimited)",
  watchTokens: "Watch Tokens (CSV, e.g. ALEX,WELSH)",
  maxBuyAmount: "Max Buy (STX)",
  perTokenCapUsd: "Per-Token Cap ($)",
  maxPriceImpactPct: "Max Price Impact (%)",
  slippageBps: "Slippage (bps)",
  cooldownMinutes: "Cooldown (min)",
  targetAddress: "Target Address (e.g. SP...)",
  maxPerTrade: "Max Per Trade (STX)",
  maxCopiesPerCycle: "Max Copies Per Cycle",
  copyRatio: "Copy Ratio (e.g. 1)",
  delaySeconds: "Delay Between Copies (s)",
  lookbackPeriods: "Lookback Periods",
  momentumThresholdPct: "Momentum Entry (%)",
  exitThresholdPct: "Exit Threshold (%)",
  positionSizeUsd: "Position Size ($)",
  maPeriods: "MA Periods",
  entryDeviationPct: "Entry Deviation (%)",
  exitDeviationPct: "Exit Deviation (%)",
  totalAmount: "Total Amount",
  slices: "Slices",
  windowMinutes: "Window (min)",
  token: "Token Symbol",
  takeProfitPct: "Take Profit (%)",
  stopLossPct: "Stop Loss (%)",
  trailingStopPct: "Trailing Stop (%)",
  topK: "Top K Tokens",
  rebalancePeriodHours: "Rebalance Period (hrs)",
  breakoutPct: "Breakout Threshold (%)",
};

export async function agentsScreen(ctx: BotContext): Promise<void> {
  ctx.session.backScreen = "main";
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(telegramId));
  if (!user) return;

  const agents = await db.prisma.tradeAgent.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });

  if (agents.length === 0) {
    try {
      await ctx.editMessageText(
        "🤖 *Trading Agents*\n\nNo agents found. Create one right here from the bot or via the web dashboard.",
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("➕ Create Agent", "action:agent_create")
            .row()
            .text("🏠 Home", "home")
        }
      );
    } catch {}
    return;
  }

  const lines = [
    "🤖 *Your Trading Agents*",
    "═════════════════════════",
    "Select an agent below to view details, configure strategies, and execute cycles:",
    "",
  ];

  agents.forEach((a) => {
    const aiLabel = (a as { aiMode?: string }).aiMode ?? "off";
    lines.push(`${a.isActive ? "✅" : "⏸"} *${escapeMd(a.name)}* (AI: \`${aiLabel}\`)`);
  });

  const keyboard = new InlineKeyboard();
  agents.forEach((a) => {
    keyboard.text(`👁 View: ${a.name}`, `action:agent_details:${a.id}`).row();
  });

  keyboard
    .text("➕ Create Agent", "action:agent_create")
    .row()
    .text("🔄 Refresh", "action:refresh_agents")
    .text("🏠 Home", "home");

  try {
    await ctx.editMessageText(lines.join("\n"), { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {}
}

export async function createAgentWizardStart(ctx: BotContext): Promise<void> {
  ctx.session.waitingFor = "agent_name";
  const text = "🤖 *Create AI Agent* (1/3)\n\nPlease enter a name for your new trading agent:\n\nType /cancel to cancel.";
  const keyboard = new InlineKeyboard().text("❌ Cancel", "action:cancel_agent_create");

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
  }
}

export async function promptAgentContext(ctx: BotContext, name: string): Promise<void> {
  ctx.session.waitingFor = "agent_context";
  const text = `🤖 *Create AI Agent* (2/3)\n\nSelected Name: *${escapeMd(name)}*\n\nSelect a strategy context for the agent:`;
  const keyboard = new InlineKeyboard()
    .text("📊 Portfolio Rebalance", "action:agent_ctx:portfolio_rebalance").row()
    .text("📈 Grid Trading", "action:agent_ctx:grid").row()
    .text("🎯 Sniper", "action:agent_ctx:sniper").row()
    .text("⚙️ Custom Strategy", "action:agent_ctx:custom").row()
    .text("❌ Cancel", "action:cancel_agent_create");

  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
}

export async function promptAgentAiMode(ctx: BotContext, name: string, context: string): Promise<void> {
  ctx.session.waitingFor = "agent_aimode";
  const text = `🤖 *Create AI Agent* (3/3)\n\nSelected Name: *${escapeMd(name)}*\nSelected Context: *${escapeMd(context)}*\n\nSelect the AI decision mode for the agent:`;
  const keyboard = new InlineKeyboard()
    .text("📴 Off (Manual)", "action:agent_ai:off").row()
    .text("💡 Advisor (Suggestions)", "action:agent_ai:advisor").row()
    .text("🤖 Autonomous (Self-Trading)", "action:agent_ai:autonomous").row()
    .text("❌ Cancel", "action:cancel_agent_create");

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
  }
}

export async function startStrategyWizard(ctx: BotContext, agentId: number): Promise<void> {
  ctx.session.activeAgentId = agentId;
  ctx.session.tempStrategyConfig = {};
  ctx.session.tempStrategyWalletIds = [];

  const keyboard = new InlineKeyboard()
    .text("📊 Rebalance", "action:strat_type:portfolio_rebalance")
    .text("📈 Grid", "action:strat_type:grid")
    .text("⏱ DCA", "action:strat_type:dca").row()
    .text("🎯 Sniper", "action:strat_type:sniper")
    .text("📋 Copy", "action:strat_type:copy")
    .text("📈 Momentum", "action:strat_type:momentum").row()
    .text("🔄 Mean Rev", "action:strat_type:mean_reversion")
    .text("⌛ TWAP", "action:strat_type:twap")
    .text("🛡️ SL/TP", "action:strat_type:stop_loss_tp").row()
    .text("🔁 Rotation", "action:strat_type:rotational")
    .text("↗️ Breakout", "action:strat_type:breakout")
    .text("← Back", `action:agent_details:${agentId}`);

  const text = "➕ *Add Trading Strategy - Step 1*\n\nSelect the strategy type you want to add to this agent:";
  try {
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {}
}

export async function promptStrategyWallets(ctx: BotContext): Promise<void> {
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

  const selectedIds = ctx.session.tempStrategyWalletIds ?? [];
  const keyboard = new InlineKeyboard();

  wallets.forEach((w) => {
    const isSelected = selectedIds.includes(w.id);
    const checkmark = isSelected ? "✅" : "⬜";
    keyboard.text(`${checkmark} ${w.name}`, `action:strat_wallet_toggle:${w.id}`).row();
  });

  keyboard.text("Next ➡️", "action:strat_wallet_confirm").row()
    .text("❌ Cancel", "action:cancel_session");

  const text = "➕ *Add Trading Strategy - Step 2*\n\nSelect the wallets to execute this strategy:";
  try {
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {}
}

export async function promptStrategyField(ctx: BotContext): Promise<void> {
  const type = ctx.session.tempStrategyType;
  if (!type) return;

  const fields = STRATEGY_FIELDS[type] ?? [];
  ctx.session.tempStrategyFields = fields;

  const idx = ctx.session.tempStrategyFieldIndex ?? 0;
  ctx.session.tempStrategyFieldIndex = idx;

  if (idx >= fields.length) {
    return promptStrategyConfirm(ctx);
  }

  const field = fields[idx]!;
  ctx.session.waitingFor = `strat_field:${field}`;

  const label = STRATEGY_LABELS[field] ?? field;
  const keyboard = new InlineKeyboard().text("❌ Cancel", "action:cancel_session");

  const text = `➕ *Add Trading Strategy - Parameter ${idx + 1}/${fields.length}*\n\nPlease enter the value for:\n*${label}*\n\nType /cancel to abort.`;
  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
}

export async function promptStrategyConfirm(ctx: BotContext): Promise<void> {
  ctx.session.waitingFor = null;
  const agentId = ctx.session.activeAgentId;
  if (!agentId) return;

  const db = DatabaseService.getInstance();
  const agent = await db.prisma.tradeAgent.findUnique({ where: { id: agentId } });
  if (!agent) return;

  const type = ctx.session.tempStrategyType ?? "";
  const walletIds = ctx.session.tempStrategyWalletIds ?? [];
  const wallets = await db.prisma.wallet.findMany({ where: { id: { in: walletIds } } });

  const config = ctx.session.tempStrategyConfig ?? {};

  const lines = [
    `➕ *Confirm Strategy Parameters*`,
    `═════════════════════════`,
    `🤖 *Agent:* ${escapeMd(agent.name)}`,
    `📈 *Strategy Type:* \`${type}\``,
    `💼 *Executing Wallets:* ${wallets.map((w) => escapeMd(w.name)).join(", ")}`,
    ``,
    `*Configuration Parameters:*`,
  ];

  Object.entries(config).forEach(([k, v]) => {
    lines.push(`• ${k}: \`${v}\``);
  });

  const keyboard = new InlineKeyboard()
    .text("✅ Create Strategy", "action:strat_confirm_create")
    .row()
    .text("❌ Cancel", "action:cancel_session");

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: keyboard });
}

export async function runAgent(ctx: BotContext, agentId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(telegramId));
  if (!user) return;

  const agent = await db.prisma.tradeAgent.findUnique({ where: { id: agentId } });
  if (!agent || agent.userId !== user.id) {
    await ctx.reply("❌ Agent not found.");
    return;
  }

  try {
    const result = await AgentService.getInstance().runAgentCycle(agentId);
    const msg = result.strategiesExecuted > 0
      ? `✅ Agent *${escapeMd(agent.name)}* ran ${result.strategiesExecuted} strategies · ${result.actions} actions`
      : `✅ Agent *${escapeMd(agent.name)}* ran. ${result.reason ?? "No actions"}`;
    await ctx.reply(msg, { parse_mode: "Markdown" });
  } catch (err) {
    await ctx.reply("❌ Failed to run agent.");
  }
}

export async function toggleAgent(ctx: BotContext, agentId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(telegramId));
  if (!user) return;

  const agent = await db.prisma.tradeAgent.findUnique({ where: { id: agentId } });
  if (!agent || agent.userId !== user.id) {
    await ctx.reply("❌ Agent not found.");
    return;
  }

  await db.prisma.tradeAgent.update({ where: { id: agentId }, data: { isActive: !agent.isActive } });
  await ctx.reply(
    `${agent.isActive ? "⏸" : "✅"} Agent *${escapeMd(agent.name)}* ${agent.isActive ? "paused" : "activated"}.`,
    { parse_mode: "Markdown" }
  );
}

export async function setAgentAiMode(ctx: BotContext, agentId: number, mode: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(telegramId));
  if (!user) return;

  const agent = await db.prisma.tradeAgent.findUnique({ where: { id: agentId } });
  if (!agent || agent.userId !== user.id) {
    await ctx.reply("❌ Agent not found.");
    return;
  }

  await db.prisma.tradeAgent.update({ where: { id: agentId }, data: { aiMode: mode } });
  await ctx.reply(`✅ AI mode set to *${mode}* for *${escapeMd(agent.name)}*`, { parse_mode: "Markdown" });
}

export async function deleteAgent(ctx: BotContext, agentId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(telegramId));
  if (!user) return;

  const agent = await db.prisma.tradeAgent.findUnique({ where: { id: agentId } });
  if (!agent || agent.userId !== user.id) {
    await ctx.reply("❌ Agent not found.");
    return;
  }

  await db.prisma.tradeAgent.delete({ where: { id: agentId } });
  await ctx.reply(`🗑 Agent *${escapeMd(agent.name)}* deleted.`, { parse_mode: "Markdown" });
}
