import { EvmChainAdapter } from "./evmChainAdapter.js";
import { BASE_MAINNET, BASE_SEPOLIA } from "../descriptors/base.js";
import { ConfigManager } from "../../../config.js";
import type { ChainDescriptor } from "../../../types/chain.js";

/**
 * Base.
 *
 * The entire class is a descriptor choice — all behaviour lives in
 * EvmChainAdapter. This is what adding an EVM chain should cost, and it is the
 * measure of whether the chain-identity split earned its keep.
 *
 * Kept as a named class (rather than callers constructing EvmChainAdapter with
 * a descriptor) only because BASE_NETWORK still selects mainnet vs. sepolia at
 * construction time for backwards compatibility with existing deployments.
 */
export class BaseAdapter extends EvmChainAdapter {
  constructor(descriptor?: ChainDescriptor) {
    super(descriptor ?? BaseAdapter.descriptorFromConfig());
  }

  private static descriptorFromConfig(): ChainDescriptor {
    return ConfigManager.getInstance().config.BASE_NETWORK === "mainnet"
      ? BASE_MAINNET
      : BASE_SEPOLIA;
  }
}
