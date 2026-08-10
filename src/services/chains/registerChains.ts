import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { ChainAdapterRegistry } from "./chainAdapterRegistry.js";
import { DEXRegistry } from "../dex/dexRegistry.js";
import { StacksAdapter } from "./stacksAdapter.js";
import { EvmChainAdapter } from "./evm/evmChainAdapter.js";
import { SolanaAdapter } from "./svm/solanaAdapter.js";
import { UniswapV3Provider } from "../dex/providers/uniswapV3.js";
import { JupiterProvider } from "../dex/providers/jupiter.js";
import { BUILT_IN_DESCRIPTORS, parseCustomEvmChains } from "./descriptors/index.js";
import type { ChainAdapter } from "../../types/chainAdapter.js";
import type { ChainDescriptor } from "../../types/chain.js";

function adapterFor(descriptor: ChainDescriptor): ChainAdapter {
  switch (descriptor.family) {
    case "stacks":
      return new StacksAdapter(descriptor);
    case "evm":
      return new EvmChainAdapter(descriptor);
    case "svm":
      return new SolanaAdapter(descriptor);
    default:
      throw new Error(`Chain ${descriptor.chainId} has unknown family "${descriptor.family}"`);
  }
}

function registerProviderFor(descriptor: ChainDescriptor): void {
  if (!descriptor.tradable) {
    logger.info(`[chains] ${descriptor.chainId} registered as non-tradable (no DEX configured)`);
    return;
  }

  if (descriptor.family === "evm" && descriptor.evm?.dex) {
    DEXRegistry.getInstance().registerProvider(new UniswapV3Provider(descriptor));
  }

  if (descriptor.family === "svm" && descriptor.svm?.jupiterApiUrl) {
    DEXRegistry.getInstance().registerProvider(new JupiterProvider(descriptor));
  }
}

function effectiveDescriptor(descriptor: ChainDescriptor, hasPaymasterKey: boolean): ChainDescriptor {
  if (descriptor.evm?.custody !== "erc4337" || hasPaymasterKey) return descriptor;

  logger.warn(
    `[chains] ${descriptor.chainId} prefers ERC-4337 custody but PIMLICO_API_KEY is not set — ` +
    `running it with EOA custody instead. Wallets on this chain pay their own gas in ` +
    `${descriptor.nativeSymbol}, and calls are submitted sequentially rather than atomically. ` +
    `Set PIMLICO_API_KEY to enable sponsorship.`,
    { chainId: descriptor.chainId }
  );

  return { ...descriptor, evm: { ...descriptor.evm, custody: "eoa" } };
}

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

    const effective = effectiveDescriptor(descriptor, Boolean(config.PIMLICO_API_KEY));

    registry.register(adapterFor(effective));
    registerProviderFor(effective);
  }

  logger.info("[chains] Enabled", {
    chains: registry.list().map((d) => d.chainId),
    tradable: registry.tradable().map((d) => d.chainId),
  });
}
