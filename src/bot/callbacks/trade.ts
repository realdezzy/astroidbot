import { DatabaseService } from "../../services/db.js";
import { LimitOrderService } from "../../services/limitOrder.js";
import { walletDescriptor } from "../../services/chains/walletChain.js";
import { mainMenu } from "../screens/mainMenu.js";
import { tradeScreen } from "../screens/tradeScreen.js";
import { tradesScreen } from "../screens/tradesScreen.js";
import { ordersScreen, limitCreateScreen } from "../screens/ordersScreen.js";
import { activeChain } from "../chainContext.js";
import { tokenDetailScreen, tokenRefAt } from "../screens/tokenScreen.js";
import { ChainAdapterRegistry } from "../../services/chains/chainAdapterRegistry.js";
import { currentUser } from "../context.js";
import type { CallbackRoutes } from "./registry.js";
import { numericArg } from "./registry.js";
import { QUOTE_TTL_MS, type BotContext } from "../../types/bot.js";

/** Trade wizard, quick-trade flow, and limit orders. */

export const tradeRoutes: CallbackRoutes = {
  exact: {
    refresh_trades: (ctx) => tradesScreen(ctx),
    refresh_orders: (ctx) => ordersScreen(ctx),

    trade_token_in_custom: async (ctx) => {
      ctx.session.waitingFor = "trade_token_in";
      await ctx.reply("🔍 Type the Token In symbol (e.g. ALEX):");
    },

    trade_token_out_custom: async (ctx) => {
      ctx.session.waitingFor = "trade_token_out";
      await ctx.reply("🔍 Type the Token Out symbol (e.g. WELSH):");
    },

    trade_restart: async (ctx) => {
      clearTradeSession(ctx);
      return tradeScreen(ctx, "pick_wallet");
    },

    trade_pick_pair: async (ctx) => {
      delete ctx.session.tradePair;
      delete ctx.session.tradeDir;
      delete ctx.session.tradeAmount;
      return tradeScreen(ctx, "pick_pair");
    },

    /** The wizard's final step: token-in/token-out already chosen. */
    trade_confirm_elite: async (ctx) => {
      const user = await currentUser(ctx);
      if (!user) return;

      const walletId = ctx.session.tradeWalletId;
      if (!walletId) return;

      const db = DatabaseService.getInstance();
      const wallet = await db.findWalletById(walletId);
      if (!wallet || wallet.userId !== user.id) return;

      const chain = walletDescriptor(wallet);
      const tokenIn = ctx.session.tradeTokenIn ?? chain.nativeSymbol;
      const tokenOut = ctx.session.tradeTokenOut ?? chain.stableSymbol;
      const amount = numericAmount(ctx.session.tradeAmount);
      if (amount <= 0) return;

      // The preview is a chat message: it stays tappable indefinitely, and
      // this handler enqueues a trade that is re-quoted at execution time. So
      // confirming a stale preview meant agreeing to a number that was no
      // longer on offer — the user's only protection being their slippage
      // setting, which is not what a displayed "you will receive X" implies.
      //
      // Re-quoting is the response rather than refusing, because the user's
      // intent is unambiguous; only the price is out of date. They get the
      // same screen with current numbers and confirm again.
      const staleReason = quoteStaleness(ctx, tokenIn, tokenOut, amount);
      if (staleReason) {
        await ctx.answerCallbackQuery?.({ text: staleReason, show_alert: true }).catch(() => {});
        await ctx.reply(`⏳ ${staleReason}\n\nFetching a fresh quote…`);
        return tradeScreen(ctx, "confirm");
      }

      const { QueueManager } = await import("../../services/queue.js");
      await QueueManager.getInstance().enqueueTrade({
        walletId: wallet.id,
        userId: user.id,
        senderAddress: wallet.address,
        tokenIn,
        tokenOut,
        amountIn: amount,
        direction: "BUY",
        reason: `Telegram Swap: ${tokenIn} → ${tokenOut}`,
      });

      clearTradeSession(ctx);
      await ctx.reply(`✅ Swap enqueued: spend ${amount} ${tokenIn} to receive ${tokenOut}!`);
      return mainMenu(ctx);
    },

    /** The older pair-based flow (tradePair = "IN/OUT"). */
    trade_confirm: async (ctx) => {
      const user = await currentUser(ctx);
      if (!user) return;

      const db = DatabaseService.getInstance();
      const wallets = await db.findWalletsByUserId(user.id);
      if (wallets.length === 0) return ctx.reply("No wallet found.");
      const wallet = wallets.find((w) => w.isDefault) ?? wallets[0]!;

      const { tokenIn, tokenOut, direction } = resolvePair(
        (ctx.session.tradePair as string) ?? "",
        (ctx.session.tradeDir as string) ?? "BUY"
      );
      const amount = numericAmount(ctx.session.tradeAmount);

      if (!tokenIn || !tokenOut || amount <= 0) {
        await ctx.answerCallbackQuery({ text: "Invalid trade parameters.", show_alert: true });
        return mainMenu(ctx);
      }

      const { QueueManager } = await import("../../services/queue.js");
      await QueueManager.getInstance().enqueueTrade({
        walletId: wallet.id,
        userId: user.id,
        senderAddress: wallet.address,
        tokenIn,
        tokenOut,
        amountIn: amount,
        direction,
        reason: `Telegram trade: ${direction} ${amount} ${tokenIn} → ${tokenOut}`,
      });

      delete ctx.session.tradePair;
      delete ctx.session.tradeDir;
      delete ctx.session.tradeAmount;

      await ctx.answerCallbackQuery({ text: "✅ Trade enqueued!", show_alert: true });
      return mainMenu(ctx);
    },

    limit_create_pair: async (ctx) => {
      delete ctx.session.limitPair;
      delete ctx.session.limitDir;
      delete ctx.session.limitAmount;
      delete ctx.session.limitPrice;
      return limitCreateScreen(ctx, "pick_pair");
    },

    limit_confirm: async (ctx) => {
      const user = await currentUser(ctx);
      if (!user) return;

      const db = DatabaseService.getInstance();
      const wallets = await db.findWalletsByUserId(user.id);
      if (wallets.length === 0) return ctx.reply("No wallet found.");
      const wallet = wallets.find((w) => w.isDefault) ?? wallets[0]!;

      const { tokenIn, tokenOut, direction } = resolvePair(
        (ctx.session.limitPair as string) ?? "",
        (ctx.session.limitDir as string) ?? "BUY"
      );
      const amount = numericAmount(ctx.session.limitAmount);
      const targetPrice = numericAmount(ctx.session.limitPrice);

      if (!tokenIn || !tokenOut || amount <= 0 || targetPrice <= 0) {
        await ctx.answerCallbackQuery({ text: "Invalid parameters.", show_alert: true });
        return mainMenu(ctx);
      }

      await LimitOrderService.getInstance().create({
        userId: user.id,
        walletId: wallet.id,
        tokenIn,
        tokenOut,
        amountIn: amount,
        direction,
        targetPrice,
      });

      delete ctx.session.limitPair;
      delete ctx.session.limitDir;
      delete ctx.session.limitAmount;
      delete ctx.session.limitPrice;

      await ctx.answerCallbackQuery({ text: "✅ Limit order placed!", show_alert: true });
      return mainMenu(ctx);
    },
  },

  prefix: {
    /**
     * Token lookup results. The index refers to `session.tokenMatches` —
     * Telegram caps callback data at 64 bytes and a contract id can exceed
     * that alone, so identity cannot travel in the button.
     */
    "token_show:": async (ctx, args) => {
      const index = numericArg(args);
      if (index === null) return;
      return tokenDetailScreen(ctx, index);
    },

    /**
     * Hands a looked-up token to the trade wizard.
     *
     * The token becomes the *output* and the chain's stable the input, because
     * "trade this" from a token page overwhelmingly means buying it. The chain
     * comes from the token, not from whatever the session happened to be on —
     * otherwise picking a Base token while browsing Stacks would build a trade
     * that cannot route.
     */
    "token_trade:": async (ctx, args) => {
      const index = numericArg(args);
      if (index === null) return;

      const ref = tokenRefAt(ctx, index);
      if (!ref) {
        await ctx.reply("❌ That list has expired. Send /token again.");
        return;
      }

      const descriptor = ChainAdapterRegistry.getInstance().find(ref.chainId);
      if (!descriptor) {
        await ctx.reply(`❌ ${ref.chainId} is not enabled on this deployment.`);
        return;
      }

      ctx.session.activeChainId = ref.chainId;
      ctx.session.tradeTokenIn = descriptor.stableSymbol;
      ctx.session.tradeTokenOut = ref.contractId;
      delete ctx.session.tradeAmount;
      delete ctx.session.tradeQuote;

      return tradeScreen(ctx, "pick_wallet");
    },

    "trade_wallet_select:": async (ctx, args) => {
      const walletId = numericArg(args);
      if (walletId === null) return tradeScreen(ctx, "pick_wallet");
      ctx.session.tradeWalletId = walletId;
      return tradeScreen(ctx, "pick_token_in");
    },

    "trade_token_in_select:": async (ctx, args) => {
      ctx.session.tradeTokenIn = args.join(":");
      return tradeScreen(ctx, "pick_token_out");
    },

    "trade_token_out_select:": async (ctx, args) => {
      ctx.session.tradeTokenOut = args.join(":");
      return tradeScreen(ctx, "enter_amount");
    },

    "trade_token:": async (ctx, args) => {
      // Quoted against the active chain's native asset, not a hardcoded STX —
      // a Base user picking a token here was previously paired against STX,
      // which has no route on their chain.
      const chain = await activeChain(ctx);
      ctx.session.tradePair = `${chain.nativeSymbol}/${args.join(":")}`;
      return tradeScreen(ctx, "pick_direction");
    },

    "trade_dir:": async (ctx, args) => {
      ctx.session.tradeDir = args.join(":");
      return tradeScreen(ctx, "enter_amount");
    },

    "limit_token:": async (ctx, args) => {
      const chain = await activeChain(ctx);
      ctx.session.limitPair = `${chain.nativeSymbol}/${args.join(":")}`;
      return limitCreateScreen(ctx, "pick_direction");
    },

    "limit_dir:": async (ctx, args) => {
      ctx.session.limitDir = args.join(":");
      return limitCreateScreen(ctx, "enter_amount");
    },

    "cancel_order:": (ctx, args) => ordersScreen(ctx, args.join(":")),
  },
};

function clearTradeSession(ctx: BotContext): void {
  delete ctx.session.tradeTokenIn;
  delete ctx.session.tradeTokenOut;
  delete ctx.session.tradeAmount;
  delete ctx.session.tradeWalletId;
  delete ctx.session.tradeQuote;
}

/**
 * Why the stored quote can't be honoured, or null if it can.
 *
 * Checks the trade parameters as well as the age. The session is mutable — a
 * user can go back, change the amount, and land on a preview still rendered
 * from the previous quote — so an age check alone would happily confirm a
 * fresh quote for the wrong trade.
 */
function quoteStaleness(
  ctx: BotContext,
  tokenIn: string,
  tokenOut: string,
  amount: number
): string | null {
  const quote = ctx.session.tradeQuote;
  if (!quote) return "This quote is no longer available.";

  if (Date.now() - quote.quotedAt > QUOTE_TTL_MS) {
    const age = Math.round((Date.now() - quote.quotedAt) / 1000);
    return `That quote is ${age}s old and prices have moved on.`;
  }

  if (quote.tokenIn !== tokenIn || quote.tokenOut !== tokenOut || quote.amountIn !== amount) {
    return "The trade changed after this quote was taken.";
  }

  return null;
}

function numericAmount(raw: unknown): number {
  return typeof raw === "number" ? raw : parseFloat(String(raw ?? "0"));
}

/** "IN/OUT" plus a direction becomes the actual spend/receive pair. */
function resolvePair(
  pair: string,
  dir: string
): { tokenIn: string; tokenOut: string; direction: "BUY" | "SELL" } {
  const [first, second] = pair.split("/");
  const buying = dir !== "SELL";
  return {
    tokenIn: (buying ? first : second) ?? "",
    tokenOut: (buying ? second : first) ?? "",
    direction: buying ? "BUY" : "SELL",
  };
}
