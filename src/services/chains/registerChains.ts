import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { ChainAdapterRegistry } from "./chainAdapterRegistry.js";
import { DEXRegistry } from "../dex/dexRegistry.js";
import { StacksAdapter } from "./stacksAdapter.js";
import { EvmChainAdapter } from "./evm/evmChainAdapter.js";
import { UniswapV3Provider } from "../dex/providers/uniswapV3.js";
import { BUILT_IN_DESCRIPTORS, parseCustomEvmChains } from "./descriptors/index.js";
import type { ChainAdapter } from "../../types/chainAdapter.js";
import type { ChainDescriptor } from "../../types/chain.js";

/**
 * Builds the adapter for a descriptor. One switch on family — the only place
 * in the codebase that needs to know which class implements which shape.
 */
function adapterFor(descriptor: ChainDescriptor): ChainAdapter {
  switch (descriptor.family) {
    case "stacks":
      return new StacksAdapter(descriptor);
    case "evm":
      return new EvmChainAdapter(descriptor);
    case "svm":
      throw new Error(
        `Chain ${descriptor.chainId}: Solana support is not implemented yet (see Docs/multichain-implementation-plan.md P3)`
      );
    default:
      throw new Error(`Chain ${descriptor.chainId} has unknown family "${descriptor.family}"`);
  }
}

/**
 * Registers a DEX provider for a chain, if it has one configured.
 *
 * A chain with no `dex` block is registered as a wallet/balance chain only —
 * DEXRegistry never offers it a quote, which is exactly right for a network
 * whose router deployments don't exist yet.
 */
function registerProviderFor(descriptor: ChainDescriptor): void {
  if (!descriptor.tradable) {
    logger.info(`[chains] ${descriptor.chainId} registered as non-tradable (no DEX configured)`);
    return;
  }

  if (descriptor.family === "evm" && descriptor.evm?.dex) {
    DEXRegistry.getInstance().registerProvider(new UniswapV3Provider(descriptor));
  }
  // Stacks providers (ALEX/Bitflow/Velar) are registered directly by
  // bootstrap: they are per-DEX rather than per-chain and predate descriptors.
}

/**
 * Registers every chain named in ENABLED_CHAINS.
 *
 * Failures are fatal, deliberately. A chain that fails to register is
 * indistinguishable from one that was never configured — the user just sees
 * "chain not enabled" and no error anywhere — and that is precisely the class
 * of invisible failure the family-keyed registry used to produce.
 */
export function registerEnabledChains(): void {
  const config = ConfigManager.getInstance().config;
  const registry = ChainAdapterRegistry.getInstance();

  const catalogue = new Map<string, ChainDescriptor>(
    [...BUILT_IN_DESCRIPTORS, ...parseCustomEvmChains(config.CUSTOM_EVM_CHAINS)].map((d) => [
      d.chainId,
      d,
    ])
  );

  const requested = config.ENABLED_CHAINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (requested.length === 0) {
    throw new Error("ENABLED_CHAINS is empty — at least one chain must be enabled");
  }

  for (const chainId of requested) {
    const descriptor = catalogue.get(chainId);
    if (!descriptor) {
      throw new Error(
        `ENABLED_CHAINS names unknown chain "${chainId}". ` +
        `Known: ${[...catalogue.keys()].join(", ")}. ` +
        `For a network not listed, add it via CUSTOM_EVM_CHAINS.`
      );
    }

    // Fail here rather than at first trade: a 4337 chain with no key would
    // otherwise register fine and then throw on every swap.
    if (descriptor.evm?.custody === "erc4337" && !config.PIMLICO_API_KEY) {
      throw new Error(
        `Chain "${chainId}" uses ERC-4337 custody but PIMLICO_API_KEY is not set. ` +
        `Set the key, or configure the chain with custody "eoa".`
      );
    }

    registry.register(adapterFor(descriptor));
    registerProviderFor(descriptor);
  }

  logger.info("[chains] Enabled", {
    chains: registry.list().map((d) => d.chainId),
    tradable: registry.tradable().map((d) => d.chainId),
  });
}
