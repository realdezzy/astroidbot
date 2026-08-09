import type { ChainDescriptor, EvmChainConfig } from "../../../types/chain.js";

export interface EvmChainSpec {
  chainId: string;
  displayName: string;
  /** EIP-155 numeric id. */
  id: number;
  rpcUrl: string;
  nativeSymbol: string;
  nativeDecimals?: number;
  stableSymbol: string;
  isTestnet?: boolean;
  explorerBaseUrl?: string;
  custody?: EvmChainConfig["custody"];
  bundlerSlug?: string;
  wrappedNative?: `0x${string}`;
  dex?: EvmChainConfig["dex"];
  tokens?: EvmChainConfig["tokens"];
}

/**
 * Builds a ChainDescriptor for an arbitrary EVM network.
 *
 * This is how chains whose parameters we cannot hardcode get added — either
 * because they are new enough that their router addresses aren't settled, or
 * because a deployment wants a chain we've never heard of. `ENABLED_CHAINS`
 * plus a `CUSTOM_EVM_CHAINS` JSON entry is enough; no code change, no release.
 *
 * `tradable` is derived, not asserted: a chain is tradable exactly when it has
 * a DEX configured. A network with no router yet is still perfectly useful for
 * wallets, balances and discovery — it simply can't be routed through, and
 * DEXRegistry will never offer it a quote.
 */
export function defineEvmChain(spec: EvmChainSpec): ChainDescriptor {
  const explorer = spec.explorerBaseUrl?.replace(/\/$/, "");

  if (spec.custody === "erc4337" && !spec.bundlerSlug) {
    throw new Error(
      `Chain ${spec.chainId} requests erc4337 custody but provides no bundlerSlug`
    );
  }

  return {
    chainId: spec.chainId,
    family: "evm",
    displayName: spec.displayName,
    nativeSymbol: spec.nativeSymbol,
    nativeDecimals: spec.nativeDecimals ?? 18,
    stableSymbol: spec.stableSymbol,
    isTestnet: spec.isTestnet ?? false,
    tradable: Boolean(spec.dex),
    explorerTxUrl: (txId) => (explorer ? `${explorer}/tx/${txId}` : txId),
    explorerAddressUrl: (address) => (explorer ? `${explorer}/address/${address}` : address),
    evm: {
      id: spec.id,
      defaultRpcUrl: spec.rpcUrl,
      // EOA is the default: it works on every EVM chain, whereas ERC-4337
      // requires a bundler that has actually deployed support for the network.
      custody: spec.custody ?? "eoa",
      ...(spec.bundlerSlug
        ? { bundler: { provider: "pimlico" as const, slug: spec.bundlerSlug } }
        : {}),
      ...(spec.wrappedNative ? { wrappedNative: spec.wrappedNative } : {}),
      ...(spec.dex ? { dex: spec.dex } : {}),
      ...(spec.tokens ? { tokens: spec.tokens } : {}),
    },
  };
}

/**
 * Parses the CUSTOM_EVM_CHAINS env var — a JSON array of EvmChainSpec.
 *
 * Deliberately strict: a malformed entry throws at startup rather than being
 * skipped. A chain that silently fails to register looks identical to one that
 * was never requested, and that class of invisible failure is exactly what the
 * family-keyed registry used to produce.
 */
export function parseCustomEvmChains(json: string | undefined): ChainDescriptor[] {
  if (!json || !json.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `CUSTOM_EVM_CHAINS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("CUSTOM_EVM_CHAINS must be a JSON array of chain specs");
  }

  return parsed.map((entry, i) => {
    const spec = entry as Partial<EvmChainSpec>;
    for (const key of ["chainId", "displayName", "id", "rpcUrl", "nativeSymbol", "stableSymbol"] as const) {
      if (spec[key] === undefined || spec[key] === null || spec[key] === "") {
        throw new Error(`CUSTOM_EVM_CHAINS[${i}] is missing required field "${key}"`);
      }
    }
    return defineEvmChain(spec as EvmChainSpec);
  });
}
