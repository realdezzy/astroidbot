import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Search, Flame, TrendingUp, Sparkles, ArrowUpDown, Layers } from "lucide-react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { classNames } from "../lib/utils";
import { ChainBadge } from "../components/ChainBadge";

/**
 * Public token discovery — a market screener.
 *
 * Structured as a screener rather than a dashboard list: dense rows, every
 * column a number a trader compares *across* rows. The previous version showed
 * six columns (token, chain, price, 24h, volume, action) while the API had
 * been returning 5m/1h/6h changes, buy and sell counts, liquidity, market cap
 * and pair age the whole time. The data was there; the page wasn't asking for
 * it.
 *
 * Density is functional here, not stylistic. Comparing tokens means reading
 * one field down many rows at once, so numbers are monospaced and
 * right-aligned to make digits line up, and colour carries direction so a
 * column can be scanned without being read.
 */

interface DiscoveredToken {
  contractId: string;
  symbol: string;
  name: string;
  chainId: string;
  chainName: string;
  dexId: string;
  priceUsd: number | null;
  priceChange: {
    m5: number | null;
    h1: number | null;
    h6: number | null;
    h24: number | null;
  };
  volume24h: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  txns24h: { buys: number | null; sells: number | null };
  pairCreatedAt: number | null;
  isVerified: boolean;
}

interface DiscoverResponse {
  items: DiscoveredToken[];
  total: number;
  page: number;
  pageSize: number;
}

interface ChainInfo {
  chainId: string;
  displayName: string;
}

const CATEGORIES = [
  { id: "trending", label: "Trending", icon: Flame },
  { id: "gainers", label: "Gainers", icon: TrendingUp },
  { id: "new", label: "New", icon: Sparkles },
  { id: "all", label: "All", icon: ArrowUpDown },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

/**
 * Compact USD.
 *
 * Long-tail tokens price at 1e-7 and majors at 1e5 in the same column. Fixed
 * decimals render one group as `$0.00` and the other as an unreadable run of
 * digits, so precision follows magnitude.
 */
function usd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `$${value.toFixed(2)}`;
  if (abs === 0) return "$0";

  // Sub-cent prices are the long tail's normal range, and both naive options
  // fail: toFixed(2) renders every one of them as $0.00, and toPrecision(3)
  // switches to exponent notation below 1e-7 — "$9.50e-8" is not a price
  // anyone reads. Expand to enough decimals for three significant digits.
  const places = Math.min(18, Math.ceil(-Math.log10(abs)) + 2);
  return `$${value.toFixed(places)}`;
}

function count(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

/** `pairCreatedAt` → `3d`, `5h`, `12m`. */
function age(createdAt: number | null): string {
  if (!createdAt) return "—";
  const minutes = Math.floor((Date.now() - createdAt) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

/**
 * A percentage cell.
 *
 * Null renders as a dash, never as 0%. "No data for this window" and "did not
 * move" are different facts, and showing the first as the second makes a token
 * with no coverage look stable.
 */
function Change({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) {
    return <span className="text-muted-text/50">—</span>;
  }

  const positive = value > 0;
  const flat = value === 0;

  return (
    <span
      className={classNames(
        "font-mono tabular-nums",
        flat ? "text-muted-text" : positive ? "text-emerald-400" : "text-red-400"
      )}
    >
      {positive ? "+" : ""}
      {value.toFixed(2)}%
    </span>
  );
}

export function TokenDiscovery() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [category, setCategory] = useState<CategoryId>("trending");
  const [chainId, setChainId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Never a hardcoded list: which chains exist is a deployment decision.
  const { data: chainData } = useQuery<{ chains: ChainInfo[] }>({
    queryKey: ["chains"],
    queryFn: () => apiFetch("/chains"),
    staleTime: 5 * 60_000,
  });

  const { data, isLoading } = useQuery<DiscoverResponse>({
    queryKey: ["discover", category, chainId, debounced],
    queryFn: () => {
      const params = new URLSearchParams({ category, pageSize: "50" });
      if (chainId) params.set("chainId", chainId);
      if (debounced) params.set("q", debounced);
      return apiFetch(`/tokens/discover?${params}`);
    },
    // Keeps the table on screen while a filter change loads, so the page
    // doesn't blank out on every tap.
    placeholderData: keepPreviousData,
  });

  const tokens = data?.items ?? [];

  /** Unauthenticated Trade keeps the prefill through the login round-trip. */
  function tradeHref(token: DiscoveredToken): string {
    const target = `/trade?chainId=${encodeURIComponent(token.chainId)}&tokenOut=${encodeURIComponent(token.contractId)}`;
    return user ? target : `/login?redirect=${encodeURIComponent(target)}`;
  }

  const chains = chainData?.chains ?? [];

  // Summed over the rows on screen, and labelled as such. Presenting it as a
  // platform-wide total would be a number we don't have — the API paginates,
  // and there is no totals endpoint behind it.
  const shownVolume = tokens.reduce((sum, t) => sum + (t.volume24h ?? 0), 0);
  const shownTxns = tokens.reduce(
    (sum, t) => sum + (t.txns24h.buys ?? 0) + (t.txns24h.sells ?? 0),
    0
  );

  return (
    <div className="flex min-h-screen bg-page-bg">
      {/* Chain rail. A persistent list rather than filter chips: the chain is
          the primary axis someone browses by, and chips push every chain past
          the first few off the row as more are enabled. */}
      <aside className="hidden w-52 shrink-0 border-r border-card-border bg-card-bg/40 md:block">
        <div className="sticky top-0 max-h-screen overflow-y-auto py-4">
          <div className="px-3 pb-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-text" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search"
                className="w-full rounded-lg border border-card-border bg-input-bg py-1.5 pl-8 pr-2 text-xs text-title-text placeholder-muted-text focus:border-brand-500/50 focus:outline-none"
              />
            </div>
          </div>

          <nav className="space-y-0.5 px-2">
            <button
              onClick={() => setChainId(null)}
              className={classNames(
                "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                chainId === null
                  ? "bg-brand-500/15 text-title-text"
                  : "text-muted-text hover:bg-input-bg hover:text-title-text"
              )}
            >
              <Layers className="h-4 w-4 shrink-0" />
              <span className="truncate font-medium">All chains</span>
            </button>

            {chains.map((c) => (
              <button
                key={c.chainId}
                onClick={() => setChainId(c.chainId)}
                className={classNames(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                  chainId === c.chainId
                    ? "bg-brand-500/15 text-title-text"
                    : "text-muted-text hover:bg-input-bg hover:text-title-text"
                )}
              >
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: chainColor(c.chainId) }}
                />
                <span className="truncate font-medium">{c.displayName}</span>
              </button>
            ))}
          </nav>
        </div>
      </aside>

      <div className="min-w-0 flex-1 px-4 py-5">
        {/* Summary. Scoped to what's on screen and said so — a platform-wide
            total is a number this API doesn't expose. */}
        <div className="mb-4 grid grid-cols-2 gap-3 sm:max-w-lg">
          <div className="rounded-xl border border-card-border bg-card-bg px-4 py-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-text">
              24H Volume · shown
            </p>
            <p className="mt-0.5 font-mono text-lg font-bold tabular-nums text-title-text">
              {usd(shownVolume)}
            </p>
          </div>
          <div className="rounded-xl border border-card-border bg-card-bg px-4 py-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-text">
              24H Txns · shown
            </p>
            <p className="mt-0.5 font-mono text-lg font-bold tabular-nums text-title-text">
              {shownTxns.toLocaleString()}
            </p>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {CATEGORIES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setCategory(id)}
              className={classNames(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                category === id
                  ? "bg-brand-500 text-white"
                  : "bg-card-bg text-muted-text hover:text-title-text"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}

          <div className="ml-auto md:hidden">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              className="w-40 rounded-lg border border-card-border bg-input-bg px-2.5 py-1.5 text-xs text-title-text placeholder-muted-text focus:outline-none"
            />
          </div>
        </div>

        {/* Scrolls horizontally rather than dropping columns: the comparison
            is the product, and a hidden column can't be compared. */}
        <div className="overflow-x-auto rounded-xl border border-card-border bg-card-bg">
          <table className="w-full min-w-[1100px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-card-border text-[11px] uppercase tracking-wide text-muted-text">
                <th className="px-3 py-2.5 text-left font-medium">#</th>
                <th className="px-3 py-2.5 text-left font-medium">Token</th>
                <th className="px-3 py-2.5 text-right font-medium">MCap</th>
                <th className="px-3 py-2.5 text-right font-medium">Price</th>
                <th className="px-3 py-2.5 text-right font-medium">Age</th>
                <th className="px-3 py-2.5 text-right font-medium">Txns</th>
                <th className="px-3 py-2.5 text-right font-medium">Volume</th>
                <th className="px-3 py-2.5 text-right font-medium">Liquidity</th>
                <th className="px-3 py-2.5 text-right font-medium">5M</th>
                <th className="px-3 py-2.5 text-right font-medium">1H</th>
                <th className="px-3 py-2.5 text-right font-medium">6H</th>
                <th className="px-3 py-2.5 text-right font-medium">24H</th>
                <th className="px-3 py-2.5 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {isLoading && tokens.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-3 py-16 text-center text-sm text-muted-text">
                    Loading tokens…
                  </td>
                </tr>
              ) : tokens.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-3 py-16 text-center text-sm text-muted-text">
                    No tokens match those filters.
                  </td>
                </tr>
              ) : (
                tokens.map((token, index) => (
                  <tr
                    key={`${token.chainId}:${token.contractId}`}
                    onClick={() =>
                      navigate(
                        `/tokens/${encodeURIComponent(token.chainId)}/${encodeURIComponent(token.contractId)}`
                      )
                    }
                    className="cursor-pointer border-b border-card-border/50 transition-colors last:border-0 hover:bg-input-bg/60"
                  >
                    <td className="px-3 py-2.5 text-xs text-muted-text">{index + 1}</td>

                    <td className="px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-title-text">{token.symbol}</span>
                          <span className="truncate text-xs text-muted-text">{token.name}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <ChainBadge chainId={token.chainId} />
                          <span className="text-[10px] uppercase text-muted-text/70">
                            {token.dexId}
                          </span>
                        </div>
                      </div>
                    </td>

                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-brand-400">
                      {usd(token.marketCapUsd)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-title-text">
                      {usd(token.priceUsd)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-text">
                      {age(token.pairCreatedAt)}
                    </td>

                    {/* Buys and sells split, because the ratio is the signal —
                        a total alone hides one-sided flow entirely. */}
                    <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums">
                      {token.txns24h.buys === null && token.txns24h.sells === null ? (
                        <span className="text-muted-text/50">—</span>
                      ) : (
                        <span>
                          <span className="text-emerald-400">{count(token.txns24h.buys)}</span>
                          <span className="text-muted-text/50"> / </span>
                          <span className="text-red-400">{count(token.txns24h.sells)}</span>
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-title-text">
                      {usd(token.volume24h)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-text">
                      {usd(token.liquidityUsd)}
                    </td>

                    <td className="px-3 py-2.5 text-right text-xs">
                      <Change value={token.priceChange.m5} />
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs">
                      <Change value={token.priceChange.h1} />
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs">
                      <Change value={token.priceChange.h6} />
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs">
                      <Change value={token.priceChange.h24} />
                    </td>

                    <td className="px-3 py-2.5 text-right">
                      <Link
                        to={tradeHref(token)}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded-md bg-brand-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-600"
                      >
                        Trade
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-xs text-muted-text">
          {data?.total ?? 0} tokens. Prices come from on-chain swaps we index ourselves,
          not a third-party feed — a dash means no data for that window, which is not
          the same as no movement.
        </p>
      </div>
    </div>
  );
}

/**
 * A stable colour per chain, derived from its id.
 *
 * Hashed rather than hardcoded so a newly enabled chain gets a distinct dot
 * without a code change — the same reason the chain list itself comes from
 * /api/chains.
 */
function chainColor(chainId: string): string {
  let hash = 0;
  for (let i = 0; i < chainId.length; i++) hash = chainId.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360} 70% 55%)`;
}

export default TokenDiscovery;
