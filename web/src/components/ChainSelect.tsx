import { useChains, type ChainInfo } from "../hooks/useChains";
import { classNames } from "../lib/utils";

/**
 * Chain picker, shared by every surface that has to ask "which network?".
 *
 * Shown even when a deployment runs a single chain. It costs one visible row
 * and it makes the network explicit at the moment it is decided — which for
 * wallet provisioning is the moment it matters most, since the answer is
 * permanent for that wallet's funds.
 *
 * `tradableOnly` separates the two questions the product asks. Creating a
 * wallet is legitimate on any chain we can hold funds on; picking a chain to
 * trade on is not, so the Trade and limit-order forms pass true.
 */
export function ChainSelect({
  value,
  onChange,
  tradableOnly = false,
  disabled = false,
  label = "Chain",
  hint,
}: {
  value: string | null;
  onChange: (chainId: string) => void;
  tradableOnly?: boolean;
  disabled?: boolean;
  label?: string | null;
  hint?: string;
}) {
  const { chains, tradable, isLoading } = useChains();
  const options: ChainInfo[] = tradableOnly ? tradable : chains;

  if (isLoading) {
    return (
      <div className="text-xs text-muted-text">Loading chains...</div>
    );
  }

  if (options.length === 0) {
    return (
      <div className="text-xs text-amber-300">
        No {tradableOnly ? "tradable " : ""}chains are enabled on this deployment.
      </div>
    );
  }

  return (
    <div>
      {label && (
        <label className="text-xs font-medium text-muted-text block mb-1.5">{label}</label>
      )}
      <div className="flex flex-wrap gap-2">
        {options.map((chain) => (
          <button
            key={chain.chainId}
            type="button"
            disabled={disabled}
            onClick={() => onChange(chain.chainId)}
            className={classNames(
              "px-3 py-2 rounded-xl border text-sm font-medium transition-colors disabled:opacity-50",
              value === chain.chainId
                ? "border-brand-500 bg-brand-500/10 text-brand-300"
                : "border-divider-color bg-input-bg text-muted-text hover:border-brand-500/50 hover:text-title-text"
            )}
          >
            <span className="flex items-center gap-1.5">
              {chain.displayName}
              <span className="text-[10px] opacity-60 font-mono">{chain.nativeSymbol}</span>
              {chain.isTestnet && (
                <span className="text-[10px] px-1 rounded bg-amber-500/20 text-amber-300">test</span>
              )}
            </span>
          </button>
        ))}
      </div>
      {hint && <p className="text-xs text-muted-text/70 mt-1.5">{hint}</p>}
    </div>
  );
}
