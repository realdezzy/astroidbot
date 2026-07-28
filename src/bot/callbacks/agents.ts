import { DatabaseService } from "../../services/db.js";
import { escapeMd } from "../utils.js";
import { currentUser } from "../context.js";
import { mainMenu } from "../screens/mainMenu.js";
import {
  agentsScreen,
  runAgent,
  toggleAgent,
  setAgentAiMode,
  deleteAgent,
  startStrategyWizard,
  promptStrategyWallets,
  promptStrategyField,
} from "../screens/agentsScreen.js";
import type { CallbackRoutes } from "./registry.js";
import { numericArg } from "./registry.js";
import type { BotContext } from "../../types/bot.js";

/** Agent management and the strategy-creation wizard. */

// agentDetailsScreen is imported lazily throughout: it pulls in the strategy
// config schemas, and eagerly importing it here would make every bot start-up
// pay for a screen most sessions never open.
async function detailsScreen(ctx: BotContext, id: number) {
  const { agentDetailsScreen } = await import("../screens/agentDetailsScreen.js");
  return agentDetailsScreen(ctx, id);
}

async function strategiesMenu(ctx: BotContext, agentId: number) {
  const { agentStrategiesMenuScreen } = await import("../screens/agentDetailsScreen.js");
  return agentStrategiesMenuScreen(ctx, agentId);
}

export const agentRoutes: CallbackRoutes = {
  exact: {
    refresh_agents: (ctx) => agentsScreen(ctx),

    agent_create: async (ctx) => {
      const { createAgentWizardStart } = await import("../screens/agentsScreen.js");
      return createAgentWizardStart(ctx);
    },

    cancel_agent_create: async (ctx) => {
      ctx.session.waitingFor = null;
      delete ctx.session.tempAgentName;
      delete ctx.session.tempAgentContext;
      await ctx.reply("❌ Agent creation cancelled.");
      return agentsScreen(ctx);
    },

    strat_wallet_confirm: async (ctx) => {
      const selected = ctx.session.tempStrategyWalletIds ?? [];
      if (selected.length === 0) {
        await ctx.answerCallbackQuery({
          text: "Please select at least one wallet.",
          show_alert: true,
        });
        return;
      }
      ctx.session.tempStrategyFieldIndex = 0;
      return promptStrategyField(ctx);
    },

    strat_confirm_create: async (ctx) => {
      const db = DatabaseService.getInstance();
      const user = await currentUser(ctx);

      if (user && ctx.session.activeAgentId && ctx.session.tempStrategyType) {
        await db.prisma.tradingStrategy.create({
          data: {
            userId: user.id,
            agentId: ctx.session.activeAgentId,
            type: ctx.session.tempStrategyType,
            config: {
              ...ctx.session.tempStrategyConfig,
              walletIds: ctx.session.tempStrategyWalletIds,
            },
            isActive: true,
          },
        });
        await ctx.reply("✅ Strategy created successfully!");
      }

      const agentId = ctx.session.activeAgentId!;
      ctx.session.waitingFor = null;
      delete ctx.session.tempStrategyType;
      delete ctx.session.tempStrategyConfig;
      delete ctx.session.tempStrategyWalletIds;
      delete ctx.session.tempStrategyFields;
      delete ctx.session.tempStrategyFieldIndex;

      return detailsScreen(ctx, agentId);
    },
  },

  prefix: {
    // Longest-first resolution in CallbackRouter is what lets these coexist
    // with the shorter "agent_toggle:" / "agent_delete:" routes below.
    "agent_details:": async (ctx, args) => {
      const id = numericArg(args);
      return id === null ? mainMenu(ctx) : detailsScreen(ctx, id);
    },

    "agent_toggle_details:": async (ctx, args) => {
      const id = numericArg(args);
      if (id === null) return mainMenu(ctx);
      await toggleAgent(ctx, id);
      return detailsScreen(ctx, id);
    },

    "agent_run_details:": async (ctx, args) => {
      const id = numericArg(args);
      if (id === null) return mainMenu(ctx);
      await runAgent(ctx, id);
      return detailsScreen(ctx, id);
    },

    "agent_delete_details:": async (ctx, args) => {
      const id = numericArg(args);
      if (id === null) return mainMenu(ctx);
      await deleteAgent(ctx, id);
      return agentsScreen(ctx);
    },

    "agent_aimode_menu:": async (ctx, args) => {
      const id = numericArg(args);
      if (id === null) return mainMenu(ctx);
      const { agentAiModeMenuScreen } = await import("../screens/agentDetailsScreen.js");
      return agentAiModeMenuScreen(ctx, id);
    },

    "agent_aimode_set:": async (ctx, args) => {
      const id = numericArg(args);
      const mode = args[1] ?? "off";
      if (id === null) return mainMenu(ctx);
      await setAgentAiMode(ctx, id, mode);
      return detailsScreen(ctx, id);
    },

    "agent_strategies_menu:": async (ctx, args) => {
      const id = numericArg(args);
      return id === null ? mainMenu(ctx) : strategiesMenu(ctx, id);
    },

    "agent_ctx:": async (ctx, args) => {
      const context = args.join(":");
      ctx.session.tempAgentContext = context;
      const { promptAgentAiMode } = await import("../screens/agentsScreen.js");
      await promptAgentAiMode(ctx, ctx.session.tempAgentName || "Unnamed Agent", context);
    },

    "agent_ai:": async (ctx, args) => {
      const aiMode = args.join(":");
      const user = await currentUser(ctx);
      if (!user) return;

      const name = ctx.session.tempAgentName || "Unnamed Agent";
      const context = ctx.session.tempAgentContext || "custom";

      await DatabaseService.getInstance().prisma.tradeAgent.create({
        data: { userId: user.id, name, context, aiMode, config: {}, model: "deepseek-v4-pro" },
      });

      ctx.session.waitingFor = null;
      delete ctx.session.tempAgentName;
      delete ctx.session.tempAgentContext;

      await ctx.reply(`✅ AI Agent *${escapeMd(name)}* created successfully!`, {
        parse_mode: "Markdown",
      });
      return agentsScreen(ctx);
    },

    "agent_run:": async (ctx, args) => {
      const id = numericArg(args);
      return id === null ? mainMenu(ctx) : runAgent(ctx, id);
    },

    "agent_toggle:": async (ctx, args) => {
      const id = numericArg(args);
      return id === null ? mainMenu(ctx) : toggleAgent(ctx, id);
    },

    "agent_delete:": async (ctx, args) => {
      const id = numericArg(args);
      return id === null ? mainMenu(ctx) : deleteAgent(ctx, id);
    },

    "strat_add:": async (ctx, args) => {
      const id = numericArg(args);
      return id === null ? mainMenu(ctx) : startStrategyWizard(ctx, id);
    },

    "strat_type:": async (ctx, args) => {
      ctx.session.tempStrategyType = args.join(":");
      return promptStrategyWallets(ctx);
    },

    "strat_wallet_toggle:": async (ctx, args) => {
      const walletId = numericArg(args);
      if (walletId === null) return promptStrategyWallets(ctx);

      const current = ctx.session.tempStrategyWalletIds ?? [];
      ctx.session.tempStrategyWalletIds = current.includes(walletId)
        ? current.filter((id) => id !== walletId)
        : [...current, walletId];

      return promptStrategyWallets(ctx);
    },

    "strat_toggle:": async (ctx, args) => {
      const strategyId = numericArg(args);
      if (strategyId === null) return agentsScreen(ctx);

      const db = DatabaseService.getInstance();
      const strategy = await db.prisma.tradingStrategy.findUnique({ where: { id: strategyId } });

      if (strategy) {
        await db.prisma.tradingStrategy.update({
          where: { id: strategyId },
          data: { isActive: !strategy.isActive },
        });
        await ctx.reply(`Strategy #${strategyId} ${strategy.isActive ? "paused" : "activated"}.`);
        if (ctx.session.activeAgentId) {
          return strategiesMenu(ctx, ctx.session.activeAgentId);
        }
      }

      return agentsScreen(ctx);
    },

    "strat_delete:": async (ctx, args) => {
      const strategyId = numericArg(args);
      if (strategyId === null) return agentsScreen(ctx);

      await DatabaseService.getInstance().prisma.tradingStrategy.delete({
        where: { id: strategyId },
      });
      await ctx.reply(`Strategy #${strategyId} deleted.`);

      if (ctx.session.activeAgentId) {
        return strategiesMenu(ctx, ctx.session.activeAgentId);
      }
      return agentsScreen(ctx);
    },
  },
};
