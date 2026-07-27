import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search, TrendingUp, ArrowUpRight, Info } from "lucide-react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { classNames, formatNumber } from "../lib/utils";
import { ChainBadge } from "../components/ChainBadge";

interface DiscoveredToken {
  id: number;
  chainId: string;
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl: string | null;
  priceUsd: number | null;
  priceChange24h: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  isVerified: boolean;
}

interface DiscoverResponse {
  items: DiscoveredToken[];
  total: number;
  page: number;
  pageSize: number;
  priceSource: string;
}

interface ChainInfo {
  chainId: string;
  displayName: string;
  tradable: boolean;
}

type SortKey = "volume" | "change" | "liquidity" | "symbol";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "volume", label: "Volume" },
  { key: "change", label: "24h Change" },
  { key: "liquidity", label: "Liquidity" },
  { key: "symbol", label: "Name" },
];

/**
 * Public token discovery — deliberately outside ProtectedRoute.
 *
 * Discovery is the top of the funnel; requiring a login to browse defeats it.
 * The Trade action deep-links into /trade with the chain and token already
 * chosen, and an unauthenticated visitor is sent through login with that
 * intent preserved in a redirect param rather than losing it.
 */
export function TokenDiscovery() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [chainFilter, setChainFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("volume");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, chainFilter, sort]);

  const { data: chainsData } = useQuery<{ chains: ChainInfo[] }>({
    queryKey: ["chains"],
    queryFn: () => apiFetch("/chains"),
    staleTime: 5 * 60_000,
  });

  const { data, isLoading } = useQuery<DiscoverResponse>({
    queryKey: ["token-discovery", chainFilter, sort, debouncedSearch, page],
    queryFn: () => {
      const params = new URLSearchParams({ sort, page: String(page), pageSize: "25" });
      if (chainFilter) params.set("chainId", chainFilter);
      if (debouncedSearch) params.set("q", debouncedSearch);
      return apiFetch(`/tokens/discover?${params}`);
    },
  });

  const chains = chainsData?.chains ?? [];
  const tokens = data?.items ?? [];
  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 1;

  function tradeHref(token: DiscoveredToken): string {
    const params = new URLSearchParams({
      chainId: token.chainId,
      tokenOut: token.symbol,
    });
    const target = `/trade?${params}`;
    // Preserve the full intent across the auth round-trip; landing on an empty
    // trade form after logging in loses everything the user just chose.
    return user ? target : `/login?redirect=${encodeURIComponent(target)}`;
  }

  return (
    <div className="min-h-screen bg-page-bg px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-title-text sm:text-4xl">Tokens</h1>
          <p className="mt-2 text-muted-text">
            Discover and track tokens across every chain AstroidBot supports.
          </p>
        </header>

        <div className="mb-6 flex flex-col gap-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by symbol, name or address"
              className="w-full rounded-lg border border-border-color bg-card-bg py-2.5 pl-10 pr-4 text-title-text placeholder-muted-text focus:border-brand-400 focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setChainFilter(null)}
              className={classNames(
                "rounded-full px-3 py-1.5 text-sm transition-colors",
                chainFilter === null
                  ? "bg-brand-400 text-black"
                  : "border border-border-color text-muted-text hover:text-title-text"
              )}
            >
              All chains
            </button>
            {chains.map((c) => (
              <button
                key={c.chainId}
                onClick={() => setChainFilter(c.chainId)}
                className={classNames(
                  "rounded-full px-3 py-1.5 text-sm transition-colors",
                  chainFilter === c.chainId
                    ? "bg-brand-400 text-black"
                    : "border border-border-color text-muted-text hover:text-title-text"
                )}
              >
                {c.displayName}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {SORTS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSort(s.key)}
                className={classNames(
                  "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  sort === s.key
                    ? "bg-card-bg text-title-text"
                    : "text-muted-text hover:text-title-text"
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Wide table scrolls inside its own container so the page never
            scrolls horizontally on a phone. */}
        <div className="overflow-x-auto rounded-xl border border-border-color bg-card-bg">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-border-color text-xs uppercase text-muted-text">
              <tr>
                <th className="px-4 py-3">Token</th>
                <th className="px-4 py-3">Chain</th>
                <th className="px-4 py-3 text-right">Price</th>
                <th className="px-4 py-3 text-right">24h</th>
                <th className="px-4 py-3 text-right">Volume</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-text">
                    Loading tokens…
                  </td>
                </tr>
              )}

              {!isLoading && tokens.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-text">
                    No tokens match that search.
                  </td>
                </tr>
              )}

              {tokens.map((token) => (
                <tr
                  key={`${token.chainId}:${token.contractId}`}
                  className="border-b border-border-color/50 last:border-0 hover:bg-page-bg/50"
                >
                  <td className="px-4 py-3">
                    <Link
                      to={`/tokens/${encodeURIComponent(token.chainId)}/${encodeURIComponent(token.contractId)}`}
                      className="flex items-center gap-3"
                    >
                      <span className="font-semibold text-title-text">{token.symbol}</span>
                      <span className="truncate text-xs text-muted-text">{token.name}</span>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <ChainBadge chainId={token.chainId} />
                  </td>
                  <td className="px-4 py-3 text-right text-title-text">
                    {token.priceUsd != null ? `$${formatNumber(token.priceUsd)}` : "—"}
                  </td>
                  <td
                    className={classNames(
                      "px-4 py-3 text-right",
                      token.priceChange24h == null
                        ? "text-muted-text"
                        : token.priceChange24h >= 0
                          ? "text-emerald-400"
                          : "text-red-400"
                    )}
                  >
                    {token.priceChange24h != null
                      ? `${token.priceChange24h >= 0 ? "+" : ""}${token.priceChange24h.toFixed(2)}%`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-muted-text">
                    {token.volume24h != null ? `$${formatNumber(token.volume24h)}` : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => navigate(tradeHref(token))}
                      className="inline-flex items-center gap-1 rounded-lg bg-brand-400 px-3 py-1.5 text-xs font-semibold text-black hover:bg-brand-300"
                    >
                      Trade <ArrowUpRight className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-3 text-sm">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="rounded-lg border border-border-color px-3 py-1.5 text-muted-text disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-muted-text">
              Page {page} of {totalPages}
            </span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg border border-border-color px-3 py-1.5 text-muted-text disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}

        {/* Prices come from DEX quotes, not a market-data provider. Saying so
            is the honest framing: a shallow pool can be seeded by anyone. */}
        <p className="mt-6 flex items-start gap-2 text-xs text-muted-text">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Prices and volumes are derived from on-chain DEX quotes on each token&apos;s own
          chain, not from a market-data provider. Low-liquidity pairs can be manipulated —
          verify before trading.
        </p>

        {!user && (
          <div className="mt-8 rounded-xl border border-border-color bg-card-bg p-6 text-center">
            <TrendingUp className="mx-auto mb-3 h-6 w-6 text-brand-400" />
            <p className="text-title-text">Create an account to trade any of these tokens.</p>
            <Link
              to="/register"
              className="mt-4 inline-block rounded-lg bg-brand-400 px-5 py-2 text-sm font-semibold text-black hover:bg-brand-300"
            >
              Get started
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
