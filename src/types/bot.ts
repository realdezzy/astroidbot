import type { Context, SessionFlavor } from "grammy";

/**
 * How long a quoted price stays offerable in the Telegram flow.
 *
 * A Telegram preview is a message, and a message sits in a chat until someone
 * taps it — minutes or days later. Without an expiry the Confirm button was a
 * standing order to trade at whatever the price happened to be by then, under
 * a preview quoting a number from another market.
 *
 * 60s is chosen against how the quote is actually used, not how fast prices
 * move: long enough to read a five-line preview and decide, short enough that
 * the number on screen is still the number you get.
 */
export const QUOTE_TTL_MS = 60_000;

/**
 * The quote a Confirm tap is agreeing to.
 *
 * The trade parameters are stored alongside it because the session is mutable:
 * a user can back out, change the amount, and return to a preview rendered
 * from the earlier quote. Re-checking them at confirm time is what makes the
 * expiry meaningful rather than merely time-based.
 */
export interface QuotedTrade {
  quotedAt: number;
  provider: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  amountOut: number;
}

export interface SessionData {
  waitingFor: string | null;
  backScreen: string | undefined;
  emailToLink: string | undefined;
  emailOtp: string | undefined;
  emailOtpExpiry: number | undefined;
  tradePair: string | undefined;
  tradeDir: string | undefined;
  tradeAmount: number | string | undefined;
  tradeWalletId: number | undefined;
  tradeTokenIn: string | undefined;
  tradeTokenOut: string | undefined;
  /** Set when the preview is rendered, checked when Confirm is tapped. */
  tradeQuote: QuotedTrade | undefined;
  limitPair: string | undefined;
  limitDir: string | undefined;
  limitAmount: number | string | undefined;
  limitPrice: number | string | undefined;
  tempPrivateKey: string | undefined;
  tempAddress: string | undefined;
  tempAgentName: string | undefined;
  tempAgentContext: string | undefined;
  activeAgentId: number | undefined;
  tempStrategyType: string | undefined;
  tempStrategyConfig: Record<string, unknown> | undefined;
  tempStrategyWalletIds: number[] | undefined;
  tempStrategyFields: string[] | undefined;
  tempStrategyFieldIndex: number | undefined;
  // Chain the import flow is provisioning for, set by the chain picker before
  // the key is requested. Without it the bot could only ever make Stacks
  // wallets, whatever the deployment had enabled.
  importChainId: string | undefined;
  // Chain the user is currently browsing/trading on. Token lists, quotes and
  // orders are all scoped to it — unscoped, a Base token can appear in a
  // Stacks wallet's picker and vice versa.
  activeChainId: string | undefined;
  chatHistory?: { role: "user" | "assistant"; content: string }[];
}

export type BotContext = Context & SessionFlavor<SessionData>;
