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
      return new SolanaAdapter(descriptor);
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

  if (descriptor.family === "svm" && descriptor.svm?.jupiterApiUrl) {
    DEXRegistry.getInstance().registerProvider(new JupiterProvider(descriptor));
  }
  // Stacks providers (ALEX/Bitflow/Velar) are registered directly by
  // bootstrap: they are per-DEX rather than per-chain and predate descriptors.
}

/**
 * The custody mode a chain will actually run in, given what this deployment
 * has configured.
 *
 * A descriptor's `custody` states a *preference*, not a hard requirement.
 * ERC-4337 buys atomic batching and sponsorable gas, and it needs a paymaster
 * key to do either; without one, the same chain runs perfectly well as a plain
 * EOA — the adapter has supported both modes from the start precisely so that
 * "EVM support" would not collapse into "support for the chains Pimlico
 * serves".
 *
 * Treating a missing key as fatal made that principle untrue in practice: it
 * meant Base could not be enabled at all without a Pimlico account, which is
 * an unreasonable thing to require of someone starting the platform up for the
 * first time. Degrading is loud, not silent — the warning names the
 * consequence, and `sponsorshipAvailability()` already surfaces the same fact
 * in Settings, where each chain that cannot sponsor says why.
 */
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

/**
 * Registers every chain named in ENABLED_CHAINS.
 *
 * Failures are fatal, deliberately. A chain that fails to register is
 * indistinguishable from one that was never configured — the user just sees
 * "chain not enabled" and no error anywhere — and that is precisely the class
 * of invisible failure the family-keyed registry used to produce.
 *
 * Missing *sponsorship* credentials are the one exception, and not a weakening
 * of that rule: the chain still registers, still trades, and announces the
 * difference. See `effectiveDescriptor`.
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

    // A 4337 chain with no paymaster key runs as an EOA rather than refusing
    // to boot. The old behaviour made Base unreachable without a Pimlico
    // account, which is not a reasonable prerequisite for enabling a chain.
    const effective = effectiveDescriptor(descriptor, Boolean(config.PIMLICO_API_KEY));

    registry.register(adapterFor(effective));
    registerProviderFor(effective);
  }

  logger.info("[chains] Enabled", {
    chains: registry.list().map((d) => d.chainId),
    tradable: registry.tradable().map((d) => d.chainId),
  });
}
