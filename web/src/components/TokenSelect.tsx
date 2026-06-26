import { useState, useRef, useEffect } from "react";
import { Search, ChevronDown } from "lucide-react";
import { classNames } from "../lib/utils";

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
}

const POPULAR_SYMBOLS = ["STX", "sUSDT", "USDA", "ALEX", "WELSH"];

export function TokenSelect({
  tokens,
  value,
  onChange,
  placeholder = "Select token",
  className,
}: TokenSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

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

  const filtered = tokens.filter(
    (t) =>
      t.symbol.toLowerCase().includes(search.toLowerCase()) ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.contractId.toLowerCase().includes(search.toLowerCase())
  );

  const sortedFiltered = [...filtered].sort((a, b) => {
    const idxA = POPULAR_SYMBOLS.indexOf(a.symbol);
    const idxB = POPULAR_SYMBOLS.indexOf(b.symbol);
    const isPopA = idxA !== -1;
    const isPopB = idxB !== -1;

    if (isPopA && !isPopB) return -1;
    if (!isPopA && isPopB) return 1;
    if (isPopA && isPopB) return idxA - idxB;
    return a.symbol.localeCompare(b.symbol);
  });

  const popularTokens = tokens.filter((t) => POPULAR_SYMBOLS.includes(t.symbol));
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
            {sortedFiltered.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-text">
                No tokens found
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
