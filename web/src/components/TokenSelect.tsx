import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, ChevronDown, Globe, AlertTriangle } from "lucide-react";
import { classNames } from "../lib/utils";
import { apiFetch } from "../lib/api";
import { useChains } from "../hooks/useChains";

interface Token {
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
}

interface TokenSelectProps {
  tokens: Token[];
  value: string;
  onChange: (symbol: string) => void;
  placeholder?: string;
  className?: string;
  /** Scopes the catalogue search. Without it, results span every chain. */
  chainId?: string;
}

/** A discovery row, which carries more than the tradable list does. */
interface DiscoveredToken {
  chainId: string;
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
  liquidityUsd: number | null;
  isVerified: boolean;
}

/**
 * Symbols surfaced first in the picker, per chain family.
 *
 * A single flat list was Stacks-only, so on Base the "popular" row promoted
 * five tokens that chain has never heard of and buried the ones it does. Keyed
 * by family rather than chain because the majors are shared across an EVM
 * fleet; anything more specific belongs in the descriptor, not here.
 */
const POPULAR_BY_FAMILY: Record<string, string[]> = {
  stacks: ["STX", "USDCx", "USDA", "ALEX", "WELSH"],
  evm: ["ETH", "WETH", "USDC", "USDT", "DAI"],
  svm: ["SOL", "USDC", "USDT", "JUP", "BONK"],
};

export function TokenSelect({
  tokens,
  value,
  onChange,
  placeholder = "Select token",
  className,
  chainId,
}: TokenSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const { byId } = useChains();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // The picker already receives a chainId for its remote search; the same value
  // decides which majors to promote.
  const family = byId(chainId)?.family;
  const popularSymbols = (family && POPULAR_BY_FAMILY[family]) ?? [];

  const filtered = tokens.filter(
    (t) =>
      t.symbol.toLowerCase().includes(search.toLowerCase()) ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.contractId.toLowerCase().includes(search.toLowerCase())
  );

  const sortedFiltered = [...filtered].sort((a, b) => {
    const idxA = popularSymbols.indexOf(a.symbol);
    const idxB = popularSymbols.indexOf(b.symbol);
    const isPopA = idxA !== -1;
    const isPopB = idxB !== -1;

    if (isPopA && !isPopB) return -1;
    if (!isPopA && isPopB) return 1;
    if (isPopA && isPopB) return idxA - idxB;
    return a.symbol.localeCompare(b.symbol);
  });

  /**
   * Search the catalogue when the local list has nothing.
   *
   * The tradable list is the handful of tokens the DEX providers hardcode, so
   * a token the indexer discovered — the entire long tail it exists to surface
   * — could be looked at on /tokens and not selected here. Contract addresses
   * had the same problem: nothing in a curated list matches one.
   *
   * Only queried on a miss, so the common case costs nothing.
   */
  const needsRemote = search.trim().length >= 2 && sortedFiltered.length === 0;

  const { data: remote, isFetching: searching } = useQuery<{ items: DiscoveredToken[] }>({
    queryKey: ["token-search", search, chainId],
    queryFn: () =>
      apiFetch(
        `/tokens/discover?q=${encodeURIComponent(search.trim())}&pageSize=8` +
          (chainId ? `&chainId=${encodeURIComponent(chainId)}` : "")
      ),
    enabled: needsRemote,
    staleTime: 30_000,
  });

  const remoteResults = needsRemote ? (remote?.items ?? []) : [];

  const popularTokens = tokens.filter((t) => popularSymbols.includes(t.symbol));
  const selectedToken = tokens.find((t) => t.symbol === value);

  return (
    <div ref={ref} className={classNames("relative", className)}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 bg-input-bg border border-divider-color rounded-2xl text-sm text-title-text hover:border-brand-500/50 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-brand-500/30 cursor-pointer"
      >
        {selectedToken ? (
          <div className="flex items-center gap-2">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
              style={{ backgroundColor: stringToColor(selectedToken.symbol) }}
            >
              {selectedToken.symbol.slice(0, 2).toUpperCase()}
            </div>
            <span className="font-semibold text-title-text">{selectedToken.symbol}</span>
          </div>
        ) : (
          <span className="text-muted-text/60">{placeholder}</span>
        )}
        <ChevronDown
          className={classNames(
            "w-4 h-4 text-muted-text transition-transform duration-200",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <div className="absolute z-50 mt-2 w-[320px] right-0 bg-sidebar-bg border border-divider-color rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in slide-in-from-top-2 duration-200">
          {/* Search bar */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-divider-color">
            <Search className="w-4 h-4 text-muted-text flex-shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tokens..."
              autoFocus
              className="w-full bg-transparent text-sm text-title-text placeholder:text-muted-text/60 focus:outline-none"
            />
          </div>

          {/* Popular Tokens Row */}
          {popularTokens.length > 0 && !search && (
            <div className="px-4 py-2.5 border-b border-divider-color bg-bg-hover/30">
              <div className="text-[10px] uppercase font-bold text-muted-text tracking-wider mb-2">
                Popular Tokens
              </div>
              <div className="flex flex-wrap gap-2">
                {popularTokens.map((t) => (
                  <button
                    key={t.contractId}
                    onClick={() => {
                      onChange(t.symbol);
                      setOpen(false);
                      setSearch("");
                    }}
                    className={classNames(
                      "px-2.5 py-1 bg-input-bg border border-divider-color hover:border-brand-500/50 rounded-xl text-xs font-semibold text-title-text transition-all duration-200 flex items-center gap-1.5 cursor-pointer",
                      value === t.symbol && "border-brand-500 bg-brand-500/10 text-brand-400"
                    )}
                  >
                    <div
                      className="w-4.5 h-4.5 rounded-full flex items-center justify-center text-[7px] font-bold text-white flex-shrink-0"
                      style={{ backgroundColor: stringToColor(t.symbol) }}
                    >
                      {t.symbol.slice(0, 2).toUpperCase()}
                    </div>
                    <span>{t.symbol}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Tokens List */}
          <div className="max-h-64 overflow-y-auto divide-y divide-divider-color/20">
            {sortedFiltered.length === 0 && remoteResults.length > 0 ? (
              <>
                <div className="px-4 pt-3 pb-1 flex items-center gap-1.5 text-xs text-muted-text">
                  <Globe className="w-3 h-3" /> From the token catalogue
                </div>
                {remoteResults.map((t) => (
                  <button
                    key={`${t.chainId}:${t.contractId}`}
                    onClick={() => {
                      // The contract, not the symbol: a discovered token has no
                      // entry in any provider list to look a symbol up in, and
                      // an address is unambiguous about which token was meant.
                      onChange(t.contractId);
                      setOpen(false);
                      setSearch("");
                    }}
                    className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-input-bg transition-colors text-left"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-title-text truncate">
                        {t.symbol}
                        {!t.isVerified && (
                          <AlertTriangle
                            className="inline w-3 h-3 ml-1.5 text-amber-400"
                            aria-label="Not on a curated list — check the contract"
                          />
                        )}
                      </p>
                      <p className="text-xs text-muted-text font-mono truncate">
                        {t.chainId} · {t.contractId.slice(0, 10)}…
                      </p>
                    </div>
                    {t.liquidityUsd !== null && (
                      <span className="text-xs text-muted-text whitespace-nowrap">
                        ${Math.round(t.liquidityUsd).toLocaleString()}
                      </span>
                    )}
                  </button>
                ))}
              </>
            ) : sortedFiltered.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-text">
                {searching ? "Searching every chain…" : "No tokens found"}
              </div>
            ) : (
              sortedFiltered.map((t) => (
                <button
                  key={t.contractId}
                  onClick={() => {
                    onChange(t.symbol);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={classNames(
                    "w-full flex items-center gap-3 px-4 py-3 text-sm text-left hover:bg-bg-hover transition-colors cursor-pointer",
                    value === t.symbol && "bg-brand-500/10"
                  )}
                >
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                    style={{ backgroundColor: stringToColor(t.symbol) }}
                  >
                    {t.symbol.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-semibold text-title-text">{t.symbol}</span>
                    <span className="text-muted-text ml-2 text-xs">{t.name}</span>
                  </div>
                  {value === t.symbol && (
                    <span className="w-2 h-2 rounded-full bg-brand-400 flex-shrink-0" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    "#5b8def",
    "#4ade80",
    "#fbbf24",
    "#f87171",
    "#a78bfa",
    "#2dd4bf",
    "#fb923c",
    "#f472b6",
    "#60a5fa",
    "#34d399",
  ];
  return colors[Math.abs(hash) % colors.length]!;
}
