import { ConfigManager } from "../../config.js";
import { DatabaseService } from "../db.js";
import { logger } from "../../utils/logger.js";
import type { ChainDescriptor } from "../../types/chain.js";

/**
 * Whether a chain can sponsor gas at all, and whether a given user wants it to.
 *
 * Two separate questions, and the UI needs both: a chain that *cannot* sponsor
 * should say so rather than show a toggle that silently does nothing, which is
 * what a single boolean would have produced.
 */

export interface SponsorshipAvailability {
  available: boolean;
  /** Why not, for chains that can't. Shown next to the disabled toggle. */
  reason: string | null;
}

/**
 * Sponsorship needs all three: smart-account custody (an EOA pays its own gas
 * by construction), a bundler that serves the chain, and a paymaster key.
 */
export function sponsorshipAvailability(descriptor: ChainDescriptor): SponsorshipAvailability {
  if (descriptor.family === "stacks") {
    const config = ConfigManager.getInstance().config;
    if (config.VELUMX_API_KEY) {
      return { available: true, reason: null };
    }
    return { available: false, reason: "VELUMX_API_KEY is not set on this deployment" };
  }
  if (descriptor.family !== "evm") {
    return { available: false, reason: "Gas sponsorship is an ERC-4337 or VelumX feature" };
  }
  if (descriptor.evm?.custody !== "erc4337") {
    return { available: false, reason: "This chain uses EOA custody, which pays its own gas" };
  }
  if (!descriptor.evm?.bundler) {
    return { available: false, reason: "No bundler is configured for this chain" };
  }
  if (!ConfigManager.getInstance().config.PIMLICO_API_KEY) {
    return { available: false, reason: "PIMLICO_API_KEY is not set on this deployment" };
  }
  return { available: true, reason: null };
}

/**
 * The user's choice for a chain, defaulting to sponsored.
 *
 * Defaulting to *on* matters more than it looks: every 4337 wallet created
 * before this toggle existed was funded on the assumption that gas was paid
 * for it. Defaulting to off would strand exactly those wallets, holding tokens
 * they can no longer sell because they have no native asset to pay with.
 *
 * A lookup failure also resolves to sponsored, for the same reason — a
 * database blip must not turn into "your swap reverted for want of gas".
 */
export async function sponsorGasFor(userId: number, chainId: string): Promise<boolean> {
  try {
    // ChainPreference, not TradeSettings. Reading it from the account table by
    // (userId, chain) is what used to create a duplicate settings row and hand
    // RiskManager a different set of limits than the user had configured.
    const preference = await DatabaseService.getInstance().findChainPreference(userId, chainId);
    return preference?.sponsorGas ?? true;
  } catch (error) {
    logger.warn("[gas] could not read sponsorship preference, defaulting to sponsored", {
      userId,
      chainId,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}
