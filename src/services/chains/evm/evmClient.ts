import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { requireEvmConfig, type ChainDescriptor } from "../../../types/chain.js";

/**
 * Shared RPC plumbing for EVM chains.
 *
 * EvmChainAdapter and UniswapV3Provider each grew their own copy of this pair,
 * which meant the per-chain RPC override was implemented (identically) in two
 * places and any third caller had to guess the env-var convention. The indexer
 * is that third caller, so the logic lives here now.
 */

/**
 * The env var that overrides a chain's RPC endpoint.
 *
 * Derived from the ChainId: `base:mainnet` → `RPC_URL_BASE_MAINNET`. One
 * function so the convention is stated once — six files had grown their own
 * copy of this expression, which is six chances for a deployment to set a
 * variable that only some of its code paths read.
 */
export function rpcEnvKey(chainId: string): string {
  return `RPC_URL_${chainId.toUpperCase().replace(/[:-]/g, "_")}`;
}

/**
 * Resolves a chain's RPC endpoint, preferring a per-deployment override.
 *
 * Deployments override the descriptor default to point at a paid provider —
 * public endpoints rate-limit hard, and the indexer is by far the heaviest RPC
 * consumer in the process.
 *
 * Works for any family, not just EVM: `defaultUrl` is what the caller falls
 * back to, so Solana and Stacks resolve through the same convention.
 */
export function rpcUrlOverride(chainId: string, defaultUrl: string): string {
  return process.env[rpcEnvKey(chainId)] || defaultUrl;
}

export function rpcUrlFor(descriptor: ChainDescriptor): string {
  return rpcUrlOverride(descriptor.chainId, requireEvmConfig(descriptor).defaultRpcUrl);
}

/** A read-only viem client bound to the chain's descriptor and RPC. */
export function publicClientFor(descriptor: ChainDescriptor): PublicClient {
  const evm = requireEvmConfig(descriptor);
  const url = rpcUrlFor(descriptor);

  const chain = defineChain({
    id: evm.id,
    name: descriptor.displayName,
    nativeCurrency: {
      name: descriptor.nativeSymbol,
      symbol: descriptor.nativeSymbol,
      decimals: descriptor.nativeDecimals,
    },
    rpcUrls: { default: { http: [url] } },
  });

  return createPublicClient({ chain, transport: http(url) }) as PublicClient;
}

/**
 * A client that coalesces concurrent calls into batched JSON-RPC requests.
 *
 * For the indexer this is the difference between usable and not: pricing a
 * range of swaps needs the timestamp of every block they landed in, and issued
 * one at a time that is thousands of sequential round trips — it dominated
 * everything else the indexer did. Batched, the same work is a handful of
 * requests.
 *
 * Kept separate from `publicClientFor` because batching delays each call by a
 * tick to collect its batch, which is the wrong trade for the latency-sensitive
 * single reads that trade execution makes.
 */
export function batchingPublicClientFor(descriptor: ChainDescriptor): PublicClient {
  const evm = requireEvmConfig(descriptor);
  const url = rpcUrlFor(descriptor);

  const chain = defineChain({
    id: evm.id,
    name: descriptor.displayName,
    nativeCurrency: {
      name: descriptor.nativeSymbol,
      symbol: descriptor.nativeSymbol,
      decimals: descriptor.nativeDecimals,
    },
    rpcUrls: { default: { http: [url] } },
  });

  return createPublicClient({
    chain,
    transport: http(url, { batch: { wait: 16 } }),
  }) as PublicClient;
}
