import { familyOfChainId, type ChainId } from "../../types/chain.js";

/**
 * Token-leg values the old config schema and create-form defaults wrote into
 * every new strategy, whatever its wallet's chain. The schema said STX/USDCx,
 * the form said STX/sUSDT.
 */
export const STALE_TOKEN_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  tokenIn: ["STX"],
  tokenOut: ["USDCx", "sUSDT"],
  tokenPair: ["STX/USDCx", "STX/sUSDT"],
};

export type StaleTokenRepair =
  | { action: "repair"; removed: Record<string, string>; config: Record<string, unknown> }
  | { action: "skip"; reason: "no_wallets" | "has_stacks_wallet" | "nothing_stale" };

/**
 * Decides what to strip from one saved strategy config.
 *
 * A leg is removed, not rewritten: an unset leg is filled from each wallet's
 * own chain at run time, which also covers a strategy spanning wallets on two
 * non-Stacks chains, where no single rewritten value could be right.
 *
 * Conservative on purpose. A config is touched only when every wallet it runs
 * on is off Stacks — there, STX/USDCx/sUSDT cannot route at all, so removing
 * them cannot break a working strategy. A strategy with any Stacks wallet is
 * left alone: those values trade there, and whether the user chose them or
 * inherited them is not recoverable from the row. Only the exact default
 * values are matched; anything else was typed by someone.
 */
export function planStaleTokenRepair(
  config: Record<string, unknown>,
  walletChains: ChainId[]
): StaleTokenRepair {
  if (walletChains.length === 0) return { action: "skip", reason: "no_wallets" };
  if (walletChains.some((chainId) => familyOfChainId(chainId) === "stacks")) {
    return { action: "skip", reason: "has_stacks_wallet" };
  }

  const removed: Record<string, string> = {};
  const next: Record<string, unknown> = { ...config };
  for (const [key, staleValues] of Object.entries(STALE_TOKEN_DEFAULTS)) {
    const value = config[key];
    if (typeof value === "string" && staleValues.includes(value.trim())) {
      removed[key] = value;
      delete next[key];
    }
  }

  if (Object.keys(removed).length === 0) return { action: "skip", reason: "nothing_stale" };
  return { action: "repair", removed, config: next };
}
