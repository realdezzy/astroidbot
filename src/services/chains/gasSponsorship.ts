import { ConfigManager } from "../../config.js";
import { DatabaseService } from "../db.js";
import { logger } from "../../utils/logger.js";
import type { ChainDescriptor } from "../../types/chain.js";

export interface SponsorshipAvailability {
  available: boolean;
  reason: string | null;
}

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

export async function sponsorGasFor(userId: number, chainId: string): Promise<boolean> {
  try {
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
