import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  TrendingUp,
  Flame,
  Sparkles,
  Layers,
  Lock,
  Globe,
  ArrowUpDown,
  ArrowDown,
  FlaskConical,
} from "lucide-react";
import { apiFetch } from "../lib/api";
import { classNames } from "../lib/utils";
import { AutoRefreshToggle } from "../components/AutoRefreshToggle";
import { MarqueeTicker } from "../components/MarqueeTicker";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import { TokenRow } from "./tokens/TokenRow";
import { formatCount, formatUsdCompact } from "./tokens/format";
import type {
  Category,
  ChainInfo,
  DexToken,
  SortField,
  Timeframe,
  TokensResponse,
} from "./tokens/types";

export type { DexToken } from "./tokens/types";

interface BlockedToken {
  id: number;
  contractId: string;
  symbol: string;
  createdAt: string;
}

const PAGE_SIZE = 50;

const CATEGORIES: { id: Category; label: string; icon: typeof Flame }[] = [
  { id: "trending", label: "Trending", icon: Flame },
  { id: "gainers", label: "Gainers", icon: TrendingUp },
  { id: "new", label: "New Pairs", icon: Sparkles },
  { id: "all", label: "All", icon: Layers },
];

const TIMEFRAMES: { id: Timeframe; label: string }[] = [
  { id: "m5", label: "5M" },
  { id: "h1", label: "1H" },
  { id: "h6", label: "6H" },
  { id: "h24", label: "24H" },
];

/**
 * Token discovery.
 */
export function Tokens() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isActive, toggle, timeLeft, interval } = useAutoRefresh("tokens");

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState<Category>("trending");
  const [timeframe, setTimeframe] = useState<Timeframe>("h24");
  const [chainId, setChainId] = useState("all");
  const [sort, setSort] = useState<SortField>("volume");
  const [showTestnets, setShowTestnets] = useState(false);
  const [page, setPage] = useState(1);

  // Debounced so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, category, chainId, sort, showTestnets]);

  const { data: chainData } = useQuery<{ chains: ChainInfo[] }>({
    queryKey: ["chains"],
    queryFn: () => apiFetch("/chains"),
    staleTime: 5 * 60_000,
  });

  const chains = useMemo(() => {
    const all = chainData?.chains ?? [];
    return showTestnets ? all : all.filter((c) => !c.isTestnet);
  }, [chainData, showTestnets]);

  // Looks up against the *unfiltered* list: a token's chain has to resolve
  // even when testnets are hidden from the rail.
  const byId = useCallback(
    (chainId: string | null | undefined) =>
      chainId ? chainData?.chains.find((c) => c.chainId === chainId) : undefined,
    [chainData]
  );

  // Selecting a testnet then hiding testnets would strand the filter on a
  // chain no longer offered, showing an empty table with no visible cause.
  useEffect(() => {
    if (chainId === "all") return;
    if (!chains.some((c) => c.chainId === chainId)) setChainId("all");
  }, [chains, chainId]);

  const params = new URLSearchParams();
  if (debouncedSearch) params.set("query", debouncedSearch);
  if (chainId !== "all") params.set("chainId", chainId);
  if (category !== "blocked") params.set("category", category);
  params.set("sort", sort);
  params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE));
  if (showTestnets) params.set("includeTestnets", "true");

  const { data, isLoading, isError } = useQuery<TokensResponse>({
    queryKey: ["tokens", params.toString()],
    queryFn: () => apiFetch(`/tokens?${params.toString()}`),
    refetchInterval: interval,
    placeholderData: (prev) => prev,
  });

  const { data: blockedData } = useQuery<{ blocked: BlockedToken[] }>({
    queryKey: ["blocked-tokens"],
    queryFn: () => apiFetch("/me/tokens/blocked"),
  });

  const invalidateBlocked = () =>
    queryClient.invalidateQueries({ queryKey: ["blocked-tokens"] });

  const blockMutation = useMutation({
    mutationFn: (body: { contractId: string; symbol: string }) =>
      apiFetch("/me/tokens/block", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidateBlocked,
  });

  const unblockMutation = useMutation({
    mutationFn: (contractId: string) =>
      apiFetch(`/me/tokens/block/${encodeURIComponent(contractId)}`, { method: "DELETE" }),
    onSuccess: invalidateBlocked,
  });

  const blocked = useMemo(
    () => new Set((blockedData?.blocked ?? []).map((b) => b.contractId)),
    [blockedData]
  );

  const tokens = useMemo(() => {
    const rows = data?.tokens ?? [];
    return category === "blocked" ? rows.filter((t) => blocked.has(t.contractId)) : rows;
  }, [data, category, blocked]);

  // Header totals describe the page in view, and say so — summing one page and
  // labelling it "24h volume" would overstate a whole chain by the page ratio.
  const pageTotals = useMemo(
    () => ({
      volume: tokens.reduce((sum, t) => sum + (t.volume24h ?? 0), 0),
      liquidity: tokens.reduce((sum, t) => sum + (t.liquidityUsd ?? 0), 0),
      txns: tokens.reduce(
        (sum, t) => sum + (t.txns24h?.buys ?? 0) + (t.txns24h?.sells ?? 0),
        0
      ),
    }),
    [tokens]
  );

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const startIndex = (page - 1) * PAGE_SIZE;

  const handleTrade = useCallback(
    (token: DexToken) => {
      navigate(
        `/trade?chainId=${encodeURIComponent(token.chainId)}&tokenOut=${encodeURIComponent(
          token.contractId
        )}`
      );
    },
    [navigate]
  );

  const handleToggleBlock = useCallback(
    (token: DexToken, isBlocked: boolean) => {
      if (isBlocked) unblockMutation.mutate(token.contractId);
      else blockMutation.mutate({ contractId: token.contractId, symbol: token.symbol });
    },
    [blockMutation, unblockMutation]
  );

  const hasTestnets = (chainData?.chains ?? []).some((c) => c.isTestnet);

  return (
    <div className="space-y-4">
      {/* Top 24h Moving Marquee Ticker */}
      <MarqueeTicker
        tokens={tokens.map((t) => ({
          symbol: t.symbol,
          priceChange24h: t.priceChange.h24,
          priceChange6h: t.priceChange.h6,
          priceUsd: t.priceUsd,
          chainId: t.chainId,
          contractId: t.contractId,
        }))}
        isLoading={isLoading}
      />

      {/* Summary strip */}
      <div className="glass-card p-4">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-brand-500/15 border border-brand-500/25">
              <Globe className="w-5 h-5 text-brand-400" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-title-text leading-tight">Token Discovery</h1>
              <p className="text-xs text-muted-text">
                Live DEX markets across {chains.length || "—"}{" "}
                {chains.length === 1 ? "chain" : "chains"}
                {data?.source ? ` · ${data.source}` : ""}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Stat label="Page volume" value={formatUsdCompact(pageTotals.volume)} />
            <Stat label="Page liquidity" value={formatUsdCompact(pageTotals.liquidity)} />
            <Stat label="Page txns 24h" value={formatCount(pageTotals.txns)} />
            <Stat label="Pairs" value={formatCount(total)} />
            <AutoRefreshToggle isActive={isActive} toggle={toggle} timeLeft={timeLeft} />
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="glass-card p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 overflow-x-auto">
            {CATEGORIES.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setCategory(id)}
                className={classNames(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer",
                  category === id
                    ? "bg-brand-500 text-white"
                    : "text-muted-text hover:text-title-text hover:bg-bg-hover"
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
            <button
              onClick={() => setCategory("blocked")}
              className={classNames(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer",
                category === "blocked"
                  ? "bg-danger-500/20 text-danger-400 border border-danger-500/40"
                  : "text-muted-text hover:text-title-text hover:bg-bg-hover"
              )}
            >
              <Lock className="w-3.5 h-3.5" />
              Blocked ({blocked.size})
            </button>
          </div>

          <div className="flex items-center gap-2">
            {/* Timeframe emphasises a column; it doesn't refetch. */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-input-bg border border-card-border">
              {TIMEFRAMES.map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => setTimeframe(id)}
                  className={classNames(
                    "px-2 py-1 rounded-md text-[11px] font-bold font-mono transition-colors cursor-pointer",
                    timeframe === id
                      ? "bg-brand-500 text-white"
                      : "text-muted-text hover:text-title-text"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-text" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search symbol, name or address"
                className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-input-bg border border-card-border text-xs text-title-text placeholder:text-muted-text focus:border-brand-500 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* Chain rail */}
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-divider-color">
          <div className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0 pt-2">
            <button
              onClick={() => setChainId("all")}
              className={classNames(
                "px-2.5 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap border transition-colors cursor-pointer",
                chainId === "all"
                  ? "bg-brand-500/15 text-brand-400 border-brand-500/40"
                  : "border-card-border text-muted-text hover:text-title-text"
              )}
            >
              All chains
            </button>

            {chains.map((chain) => (
              <button
                key={chain.chainId}
                onClick={() => setChainId(chain.chainId)}
                title={chain.tradable ? undefined : "Listed only — no DEX routing on this chain yet"}
                className={classNames(
                  "px-2.5 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap border transition-colors cursor-pointer flex items-center gap-1",
                  chainId === chain.chainId
                    ? "bg-brand-500/15 text-brand-400 border-brand-500/40"
                    : "border-card-border text-muted-text hover:text-title-text"
                )}
              >
                {chain.displayName}
                {chain.isTestnet && (
                  <span className="text-[8px] uppercase opacity-70 font-mono">test</span>
                )}
                {!chain.tradable && <span className="w-1 h-1 rounded-full bg-warning-500" />}
              </button>
            ))}
          </div>

          {/* Testnets are hidden by default: their prices are arbitrary and
              would otherwise rank alongside real markets. */}
          {hasTestnets && (
            <label className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-text cursor-pointer select-none pt-2 whitespace-nowrap">
              <input
                type="checkbox"
                checked={showTestnets}
                onChange={(e) => setShowTestnets(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-card-border bg-input-bg accent-brand-500 cursor-pointer"
              />
              <FlaskConical className="w-3.5 h-3.5" />
              Show testnets
            </label>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="glass-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[1100px]">
            <thead>
              <tr className="text-[10px] font-bold text-muted-text uppercase tracking-wider border-b border-divider-color">
                <th className="py-2.5 px-3 text-right w-14">#</th>
                <th className="py-2.5 px-3">Token</th>
                <SortHeader label="MCap" field="mcap" sort={sort} onSort={setSort} />
                <th className="py-2.5 px-3 text-right">Price</th>
                <th className="py-2.5 px-3 text-right">Age</th>
                <th className="py-2.5 px-3 text-right">Txns 24h</th>
                <SortHeader label="Volume 24h" field="volume" sort={sort} onSort={setSort} />
                <th className="py-2.5 px-3 text-right">5M</th>
                <th className="py-2.5 px-3 text-right">1H</th>
                <th className="py-2.5 px-3 text-right">6H</th>
                <SortHeader label="24H" field="change" sort={sort} onSort={setSort} />
                <SortHeader label="Liquidity" field="liquidity" sort={sort} onSort={setSort} />
                <th className="py-2.5 px-3 text-right">Trade</th>
              </tr>
            </thead>

            <tbody className="text-xs">
              {isLoading && tokens.length === 0 ? (
                <SkeletonRows />
              ) : isError ? (
                <EmptyRow>Couldn't load tokens. Retrying automatically.</EmptyRow>
              ) : tokens.length === 0 ? (
                <EmptyRow>
                  {debouncedSearch
                    ? `No tokens matching "${debouncedSearch}".`
                    : category === "blocked"
                      ? "You haven't blocked any tokens."
                      : "No tokens indexed yet for this filter."}
                </EmptyRow>
              ) : (
                tokens.map((token, i) => (
                  <TokenRow
                    key={`${token.chainId}:${token.contractId}`}
                    token={token}
                    rank={startIndex + i + 1}
                    timeframe={timeframe}
                    isBlocked={blocked.has(token.contractId)}
                    // A chain's own native asset can't be blocked — every pair
                    // on that chain routes through it. Compared against the
                    // token's own chain rather than the literal "STX", which
                    // left ETH and SOL blockable.
                    canBlock={
                      token.symbol.toUpperCase() !==
                      (byId(token.chainId)?.nativeSymbol ?? "").toUpperCase()
                    }
                    onTrade={handleTrade}
                    onToggleBlock={handleToggleBlock}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-divider-color">
            <span className="text-[11px] text-muted-text">
              {startIndex + 1}–{Math.min(startIndex + PAGE_SIZE, total)} of {formatCount(total)}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 rounded-lg text-[11px] font-bold border border-card-border text-title-text hover:bg-bg-hover disabled:opacity-40 disabled:cursor-default cursor-pointer"
              >
                Previous
              </button>
              <span className="text-[11px] font-mono text-muted-text">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1 rounded-lg text-[11px] font-bold border border-card-border text-title-text hover:bg-bg-hover disabled:opacity-40 disabled:cursor-default cursor-pointer"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-1.5 rounded-lg bg-input-bg border border-card-border">
      <div className="text-[9px] font-bold uppercase tracking-wider text-muted-text">{label}</div>
      <div className="text-sm font-bold text-title-text tabular-nums">{value}</div>
    </div>
  );
}

function SortHeader({
  label,
  field,
  sort,
  onSort,
}: {
  label: string;
  field: SortField;
  sort: SortField;
  onSort: (field: SortField) => void;
}) {
  const active = sort === field;
  return (
    <th
      onClick={() => onSort(field)}
      className={classNames(
        "py-2.5 px-3 text-right cursor-pointer select-none transition-colors",
        active ? "text-brand-400" : "hover:text-title-text"
      )}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? <ArrowDown className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3 opacity-40" />}
      </span>
    </th>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={13} className="py-16 text-center text-muted-text text-xs">
        {children}
      </td>
    </tr>
  );
}

/** Keeps the table height stable on first load so the page doesn't jump. */
function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 12 }).map((_, i) => (
        <tr key={i} className="border-b border-divider-color/40">
          <td colSpan={13} className="py-3 px-3">
            <div className="h-6 rounded bg-bg-hover animate-pulse" />
          </td>
        </tr>
      ))}
    </>
  );
}
