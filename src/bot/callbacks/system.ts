import { DatabaseService } from "../../services/db.js";
import { TelegramService } from "../../services/telegram.js";
import { BotStatus } from "../../types.js";
import { mainMenu } from "../screens/mainMenu.js";
import { portfolioScreen } from "../screens/portfolioScreen.js";
import { controlScreen } from "../screens/controlScreen.js";
import { settingsScreen } from "../screens/settingsScreen.js";
import { requireAdmin } from "../context.js";
import type { CallbackRoutes } from "./registry.js";

/** Navigation, settings, session control, and admin actions. */

export const systemRoutes: CallbackRoutes = {
  exact: {
    refresh_portfolio: (ctx) => portfolioScreen(ctx),
    refresh_control: (ctx) => controlScreen(ctx),

    link_email_start: async (ctx) => {
      ctx.session.waitingFor = "link_email";
      await ctx.reply("📧 Enter your email address:");
    },

    /**
     * Clears every in-flight wizard.
     *
     * Deliberately exhaustive: a stale `waitingFor` with half-set trade or
     * limit fields is how a "cancelled" flow resurfaces and spends against
     * values the user thought they had abandoned.
     */
    cancel_session: async (ctx) => {
      ctx.session.waitingFor = null;
      delete ctx.session.emailToLink;
      delete ctx.session.emailOtp;
      delete ctx.session.emailOtpExpiry;
      delete ctx.session.tradePair;
      delete ctx.session.tradeDir;
      delete ctx.session.tradeAmount;
      delete ctx.session.limitPair;
      delete ctx.session.limitDir;
      delete ctx.session.limitAmount;
      delete ctx.session.limitPrice;
      delete ctx.session.tempPrivateKey;
      delete ctx.session.tempAddress;
      delete ctx.session.importChainId;
      return mainMenu(ctx);
    },

    confirm_halt: async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      TelegramService.getInstance().setStatus(BotStatus.HALTED, "Admin halted");
      return controlScreen(ctx);
    },

    confirm_resume: async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      TelegramService.getInstance().setStatus(BotStatus.RUNNING);
      return controlScreen(ctx);
    },
  },

  prefix: {
    "toggle_settings:": (ctx, args) => settingsScreen(ctx, args.join(":")),
  },
};

/**
 * Bare (non-`action:`-prefixed) callbacks kept for buttons rendered by older
 * screens. Handled separately because they don't carry the prefix the action
 * dispatcher keys on.
 */
export const bareCallbacks: Record<string, (ctx: Parameters<typeof mainMenu>[0]) => Promise<unknown>> = {
  resume_cmd: async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    TelegramService.getInstance().setStatus(BotStatus.RUNNING);
    return controlScreen(ctx);
  },

  stats_cmd: async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const stats = await DatabaseService.getInstance().getStats();
    await ctx.reply(
      `📊 *System Stats*\n\nUsers: ${stats.totalUsers}\nWallets: ${stats.totalWallets}\n` +
      `Trades: ${stats.totalTrades}\nUptime: ${Math.floor(process.uptime() / 60)}m`,
      { parse_mode: "Markdown" }
    );
  },

  broadcast_cmd: async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    ctx.session.waitingFor = "broadcast_msg";
    await ctx.reply("📢 *Broadcast Message*\n\nType the message to send to all Telegram users:", {
      parse_mode: "Markdown",
    });
  },
};
