import { DatabaseService } from "./db.js";
import { logger } from "../utils/logger.js";
import type { ChainId } from "../types/chain.js";

/**
 * Resolving "what settings apply to this trade" in one place.
 *
 * Two layers, and the split is deliberate:
 *
 *  - **TradeSettings** is about the account. `maxPositionPct` and
 *    `dailyLossLimit` bound exposure across everything the user holds, so
 *    expressing them per chain would mean a user with three chains could take
 *    three times the position they asked to be limited to.
 *  - **ChainPreference** is about one network. Slippage belongs here because a
 *    Stacks AMM and a Solana aggregator are not the same trade at the same
 *    tolerance, and gas sponsorship because only some chains can do it at all.
 *
 * A chain with no row, or a null column, inherits. That is what stops enabling
 * a chain from silently resetting a preference — the failure the old
 * single-table shape had, where a sponsorship toggle wrote a fresh row full of
 * product defaults and RiskManager then enforced whichever row it read first.
 */

/** Product defaults, applied when a user has never saved anything. */
export const DEFAULT_TRADE_SETTINGS = {
  slippageBps: 100,
  maxPositionPct: 25.0,
  dailyLossLimit: 5.0,
  rebalanceThreshold: 2.0,
  useGasless: false,
  gaslessFeeToken: "USDC",
} as const;

export interface ResolvedTradeSettings {
  slippageBps: number;
  maxPositionPct: number;
  dailyLossLimit: number;
  rebalanceThreshold: number;
  useGasless: boolean;
  gaslessFeeToken: string;
  /** True when this chain overrides the account's slippage. */
  slippageIsChainOverride: boolean;
}

/**
 * The settings in force for one user on one chain.
 *
 * `chainId` is optional only so callers with genuinely no chain in hand (the
 * account settings screen) can ask for the account layer alone. Anything on a
 * trade path has a wallet, and a wallet has a chain — pass it.
 */
export async function resolveTradeSettings(
  userId: number,
  context: string,
  chainId?: ChainId | string
): Promise<ResolvedTradeSettings> {
  const db = DatabaseService.getInstance();

  try {
    const [account, chain] = await Promise.all([
      db.findTradeSettings(userId, context),
      chainId ? db.findChainPreference(userId, chainId) : Promise.resolve(null),
    ]);

    const slippageBps =
      chain?.slippageBps ?? account?.slippageBps ?? DEFAULT_TRADE_SETTINGS.slippageBps;

    return {
      slippageBps,
      maxPositionPct: account?.maxPositionPct ?? DEFAULT_TRADE_SETTINGS.maxPositionPct,
      dailyLossLimit: account?.dailyLossLimit ?? DEFAULT_TRADE_SETTINGS.dailyLossLimit,
      rebalanceThreshold: account?.rebalanceThreshold ?? DEFAULT_TRADE_SETTINGS.rebalanceThreshold,
      useGasless: account?.useGasless ?? DEFAULT_TRADE_SETTINGS.useGasless,
      gaslessFeeToken: account?.gaslessFeeToken ?? DEFAULT_TRADE_SETTINGS.gaslessFeeToken,
      slippageIsChainOverride: chain?.slippageBps != null,
    };
  } catch (error) {
    // Falling back to defaults rather than throwing: every caller is on a trade
    // path, and the defaults are the *conservative* end of each range. A
    // database blip should narrow what a trade is allowed to do, not abort it
    // with an error the user reads as a failed swap.
    logger.warn("[settings] could not resolve trade settings, using defaults", {
      userId,
      chainId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...DEFAULT_TRADE_SETTINGS, slippageIsChainOverride: false };
  }
}
