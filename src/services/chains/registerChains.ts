import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { ChainAdapterRegistry } from "./chainAdapterRegistry.js";
import { DEXRegistry } from "../dex/dexRegistry.js";
import { StacksAdapter } from "./stacksAdapter.js";
import { EvmChainAdapter } from "./evm/evmChainAdapter.js";
import { SolanaAdapter } from "./svm/solanaAdapter.js";
import { hasRpcOverride, rpcUrlOverride } from "./evm/evmClient.js";
import { UniswapV3Provider } from "../dex/providers/uniswapV3.js";
import { UniswapV2Provider } from "../dex/providers/uniswapV2.js";
import { UniswapUniversalProvider } from "../dex/providers/uniswapUniversal.js";
import { AerodromeProvider } from "../dex/providers/aerodrome.js";
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

  if (descriptor.family === "evm" && descriptor.evm) {
    const dex = descriptor.evm.dex;
    if (dex?.universalRouter) {
      DEXRegistry.getInstance().registerProvider(new UniswapUniversalProvider(descriptor));
    }
    if (dex?.quoter && dex.swapRouter) {
      DEXRegistry.getInstance().registerProvider(new UniswapV3Provider(descriptor));
    }
    if (dex?.v2Router) {
      DEXRegistry.getInstance().registerProvider(new UniswapV2Provider(descriptor));
    }
    // Aerodrome is independent of the Uniswap `dex` block: Slipstream is its
    // own set of factories and routers, and where Base's stock liquidity is.
    if (descriptor.evm.aerodrome) {
      DEXRegistry.getInstance().registerProvider(new AerodromeProvider(descriptor));
    }
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
    // Host only — an RPC URL usually carries the API key in its path, and this
    // line goes wherever the logs go. The host is what answers "is this chain
    // on the paid endpoint or still on the public default", which is the
    // question that otherwise takes a packet capture to settle.
    endpoints: Object.fromEntries(
      registry.list().map((d) => [d.chainId, rpcHostFor(d)])
    ),
  });
}

/**
 * The hostname a chain's RPC resolves to, and whether it came from an override.
 *
 * Deliberately not the full URL: these strings contain provider API keys.
 */
function rpcHostFor(descriptor: ChainDescriptor): string {
  const fallback = descriptor.evm?.defaultRpcUrl ?? descriptor.svm?.defaultRpcUrl ?? descriptor.stacks?.apiUrl;
  if (!fallback) return "n/a";

  const url = rpcUrlOverride(descriptor.chainId, fallback);
  // Asked of the environment rather than inferred by comparing the resolved
  // URL to the default — an override deliberately set to the default value is
  // still an override, and reporting it as "(default)" tells an operator their
  // setting had no effect.
  const overridden = hasRpcOverride(descriptor.chainId);

  try {
    return `${new URL(url).host}${overridden ? " (override)" : " (default)"}`;
  } catch {
    return overridden ? "(override, unparseable)" : "(default)";
  }
}
