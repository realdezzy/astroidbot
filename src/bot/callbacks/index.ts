import { CallbackRouter } from "./registry.js";
import { decodeCallback } from "./codec.js";
import { agentRoutes } from "./agents.js";
import { tradeRoutes } from "./trade.js";
import { walletRoutes, createWalletOnChain, promptKeyForChain } from "./wallet.js";
import { systemRoutes, bareCallbacks } from "./system.js";
import { isAdmin, screenMap } from "../context.js";
import { mainMenu } from "../screens/mainMenu.js";
import type { BotContext } from "../../types/bot.js";

/**
 * The single entry point for `callback_query:data`.
 *
 * Routes are registered on first use rather than at module load. There is a
 * cycle in the module graph — agentsScreen → agentService → notificationService
 * → TelegramService → router → this file → agents.ts — and building the table
 * at module scope reads `agentRoutes` while agents.ts is still initialising,
 * which throws a TDZ ReferenceError at startup. Deferring the read to the
 * first callback breaks the hazard without having to untangle the cycle, which
 * predates this file.
 *
 * Duplicate actions still throw, just at first dispatch rather than at import.
 */
let router: CallbackRouter | undefined;

function routes(): CallbackRouter {
  if (!router) {
    router = new CallbackRouter().register(
      agentRoutes,
      tradeRoutes,
      walletRoutes,
      systemRoutes
    );
  }
  return router;
}

export function callbackRouteCount() {
  return routes().routeCount();
}

export async function handleCallback(ctx: BotContext): Promise<unknown> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  // A no-op button (e.g. a pagination counter) should acknowledge the tap and
  // do nothing else, not fall through to the main menu.
  if (data === "action:noop") {
    return ctx.answerCallbackQuery();
  }

  await ctx.answerCallbackQuery();

  if (data === "home") return mainMenu(ctx);

  if (data === "screen:control" && !isAdmin(ctx)) {
    await ctx.answerCallbackQuery({ text: "🔒 Admin only", show_alert: true });
    return;
  }

  if (data.startsWith("screen:")) {
    const name = data.slice(7);

    if (name === "back") {
      const back = ctx.session.backScreen ?? "main";
      ctx.session.backScreen = undefined;
      return (screenMap[back] ?? mainMenu)(ctx);
    }

    const screen = screenMap[name];
    if (screen) return screen(ctx);
  }

  // Codec-encoded callbacks ("wallet|new|base") — pipe-separated rather than
  // "action:"-prefixed, so they resolve before the action dispatcher.
  const parsed = decodeCallback(data);
  if (parsed?.namespace === "wallet") {
    if (parsed.action === "new") return createWalletOnChain(ctx, parsed.args[0] ?? "");
    if (parsed.action === "imp") return promptKeyForChain(ctx, parsed.args[0] ?? "");
  }

  const bare = bareCallbacks[data];
  if (bare) return bare(ctx);

  if (!data.startsWith("action:")) return mainMenu(ctx);

  const { handled, result } = await routes().dispatch(ctx, data.slice(7));
  if (handled) return result;

  // Unrecognised action. Falling back to the menu matches the previous
  // behaviour and keeps a stale button from stranding the user.
  return mainMenu(ctx);
}
