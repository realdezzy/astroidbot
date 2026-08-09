import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

/**
 * The chains this deployment runs, as reported by `/api/chains`.
 *
 * One hook rather than the same inline query in every page: the chain list is
 * the thing that decides what half this UI is allowed to offer, and four
 * copies of it drifted — some filtered to `tradable`, some didn't, and the
 * wallet pages had no copy at all, which is how the web app ended up able to
 * create Stacks wallets and nothing else.
 *
 * Never hardcode a chain list against this. Enabling a chain is a config
 * change on the server, and it should show up here without a frontend release.
 */
export interface ChainInfo {
  chainId: string;
  family: "stacks" | "evm" | "svm" | string;
  displayName: string;
  nativeSymbol: string;
  nativeDecimals: number;
  stableSymbol: string;
  isTestnet: boolean;
  /** False for a chain we can hold funds on but not route a swap through. */
  tradable: boolean;
}

export interface UseChainsResult {
  chains: ChainInfo[];
  /** Only the chains a swap can actually be routed on. */
  tradable: ChainInfo[];
  byId: (chainId: string | null | undefined) => ChainInfo | undefined;
  isLoading: boolean;
}

export function useChains(): UseChainsResult {
  const { data, isLoading } = useQuery<{ chains: ChainInfo[] }>({
    queryKey: ["chains"],
    queryFn: () => apiFetch("/chains"),
    // The list changes when a deployment is reconfigured, which is not
    // something a trading session needs to poll for.
    staleTime: 5 * 60_000,
  });

  const chains = data?.chains ?? [];

  return {
    chains,
    tradable: chains.filter((c) => c.tradable),
    byId: (chainId) => (chainId ? chains.find((c) => c.chainId === chainId) : undefined),
    isLoading,
  };
}

/**
 * A readable name for a chain, even one this build has never heard of.
 *
 * Falls back to the network segment of the ChainId rather than rendering the
 * raw identifier, so an unknown chain reads as "Base" instead of
 * "base:mainnet".
 */
export function chainLabel(chainId: string | null | undefined, chains: ChainInfo[]): string {
  if (!chainId) return "Unknown chain";
  const known = chains.find((c) => c.chainId === chainId);
  if (known) return known.displayName;
  const network = chainId.split(":")[0] ?? chainId;
  return network.charAt(0).toUpperCase() + network.slice(1);
}

/**
 * The native asset ticker for a chain — what replaces the hardcoded "STX".
 *
 * Falls back to an empty string rather than to "STX": a balance rendered with
 * no unit is visibly incomplete, whereas one labelled with the wrong chain's
 * asset looks correct and is not.
 */
export function nativeSymbolOf(chainId: string | null | undefined, chains: ChainInfo[]): string {
  return chains.find((c) => c.chainId === chainId)?.nativeSymbol ?? "";
}
