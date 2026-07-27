import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import { classNames } from "../lib/utils";

interface ChainInfo {
  chainId: string;
  family: string;
  displayName: string;
  isTestnet: boolean;
  tradable: boolean;
}

/**
 * Chain label for anywhere a token or wallet is shown.
 *
 * Names come from /api/chains rather than a literal map, so enabling a chain
 * makes it render correctly everywhere at once. The fallback derives a
 * readable name from the chainId itself, so a chain this build doesn't know
 * still shows something better than a raw identifier.
 */
export function ChainBadge({ chainId, className }: { chainId: string; className?: string }) {
  const { data } = useQuery<{ chains: ChainInfo[] }>({
    queryKey: ["chains"],
    queryFn: () => apiFetch("/chains"),
    staleTime: 5 * 60_000,
  });

  const chain = data?.chains.find((c) => c.chainId === chainId);
  const network = chainId.split(":")[0] ?? chainId;
  const label = chain?.displayName ?? network.charAt(0).toUpperCase() + network.slice(1);

  const tone =
    chain?.family === "stacks"
      ? "bg-orange-500/10 text-orange-300 border-orange-500/30"
      : chain?.family === "svm"
        ? "bg-purple-500/10 text-purple-300 border-purple-500/30"
        : "bg-blue-500/10 text-blue-300 border-blue-500/30";

  return (
    <span
      className={classNames(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        tone,
        className
      )}
    >
      {label}
      {chain?.isTestnet && <span className="opacity-70">testnet</span>}
    </span>
  );
}
