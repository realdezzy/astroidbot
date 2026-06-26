import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, Lock, Unlock } from "lucide-react";
import { apiFetch } from "../lib/api";
import { classNames } from "../lib/utils";
import { AutoRefreshToggle } from "../components/AutoRefreshToggle";
import { useAutoRefresh } from "../hooks/useAutoRefresh";

interface SwappableToken {
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
}

interface BlockedToken {
  id: number;
  contractId: string;
  symbol: string;
  createdAt: string;
}

export function Tokens() {
  const queryClient = useQueryClient();
  const { isActive, toggle, timeLeft, interval } = useAutoRefresh("tokens");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "blocked" | "allowed">("all");
  const [page, setPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  useEffect(() => {
    setPage(1);
  }, [search, filter]);

  const { data: tokensData } = useQuery<{ tokens: SwappableToken[] }>({
    queryKey: ["tokens"],
    queryFn: () => apiFetch("/tokens"),
    refetchInterval: interval,
  });

  const { data: blockedData } = useQuery<{ blocked: BlockedToken[] }>({
    queryKey: ["blocked-tokens"],
    queryFn: () => apiFetch("/me/tokens/blocked"),
    refetchInterval: interval,
  });

  const blockMutation = useMutation({
    mutationFn: (data: { contractId: string; symbol: string }) =>
      apiFetch("/me/tokens/block", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blocked-tokens"] });
    },
  });

  const unblockMutation = useMutation({
    mutationFn: (contractId: string) =>
      apiFetch(`/me/tokens/block/${contractId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blocked-tokens"] });
    },
  });

  const allTokens = tokensData?.tokens ?? [];
  const blocked = new Set(
    (blockedData?.blocked ?? []).map((b) => b.contractId)
  );

  const filtered = allTokens.filter((t) => {
    const matchesSearch =
      !search ||
      t.symbol.toLowerCase().includes(search.toLowerCase()) ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.contractId.toLowerCase().includes(search.toLowerCase());

    if (!matchesSearch) return false;

    if (filter === "blocked") return blocked.has(t.contractId);
    if (filter === "allowed") return !blocked.has(t.contractId);
    return true;
  });

  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE);
  const startIndex = (page - 1) * ITEMS_PER_PAGE;
  const paginatedTokens = filtered.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    const maxVisible = 5;
    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (page > 3) {
        pages.push("...");
      }
      const start = Math.max(2, page - 1);
      const end = Math.min(totalPages - 1, page + 1);
      for (let i = start; i <= end; i++) {
        pages.push(i);
      }
      if (page < totalPages - 2) {
        pages.push("...");
      }
      pages.push(totalPages);
    }
    return pages;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-bold text-title-text">Tokens</h2>
          <p className="text-muted-text mt-1">
            Manage which tokens are included in portfolio tracking
          </p>
        </div>
        <AutoRefreshToggle
          isActive={isActive}
          toggle={toggle}
          timeLeft={timeLeft}
        />
      </div>

      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-text" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 bg-card-bg border border-divider-color rounded-lg text-sm text-title-text placeholder:text-muted-text focus:border-brand-500 focus:outline-none"
            placeholder="Search by symbol, name, or contract ID..."
          />
        </div>
        <div className="flex gap-1">
          {[
            ["all", "All"],
            ["blocked", "Blocked"],
            ["allowed", "Allowed"],
          ].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key as typeof filter)}
              className={classNames(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                filter === key
                  ? "bg-brand-500/20 text-brand-400"
                  : "text-muted-text hover:text-title-text hover:bg-bg-hover"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="glass-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-divider-color text-muted-text">
              <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                Symbol
              </th>
              <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                Name
              </th>
              <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                Contract ID
              </th>
              <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                Decimals
              </th>
              <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                Status
              </th>
              <th className="text-right py-3 px-4 text-xs font-medium uppercase tracking-wider">
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {paginatedTokens.map((token) => {
              const isBlocked = blocked.has(token.contractId);
              const isStx = token.symbol.toUpperCase() === "STX";

              return (
                <tr
                  key={token.contractId}
                  className={classNames(
                    "border-b border-divider-color transition-colors",
                    isBlocked
                      ? "bg-red-500/5 opacity-50 hover:bg-bg-hover/50"
                      : "hover:bg-bg-hover/50"
                  )}
                >
                  <td className="py-3 px-4">
                    <span className="text-sm font-medium text-title-text">
                      {token.symbol}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-sm text-muted-text">
                    {token.name}
                  </td>
                  <td className="py-3 px-4">
                    <code className="text-xs text-muted-text bg-bg-hover px-2 py-0.5 rounded">
                      {token.contractId}
                    </code>
                  </td>
                  <td className="py-3 px-4 text-sm text-muted-text">
                    {token.decimals}
                  </td>
                  <td className="py-3 px-4">
                    {isBlocked ? (
                      <span className="inline-flex items-center gap-1 text-xs text-red-400">
                        <Lock className="w-3 h-3" />
                        Blocked
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-green-400">
                        <Unlock className="w-3 h-3" />
                        Allowed
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-right">
                    {isStx ? (
                      <span className="text-xs text-muted-text/60">
                        Native token
                      </span>
                    ) : (
                      <button
                        onClick={() => {
                          if (isBlocked) {
                            unblockMutation.mutate(token.contractId);
                          } else {
                            blockMutation.mutate({
                              contractId: token.contractId,
                              symbol: token.symbol,
                            });
                          }
                        }}
                        disabled={
                          blockMutation.isPending || unblockMutation.isPending
                        }
                        className={classNames(
                          "text-xs font-medium transition-colors",
                          isBlocked
                            ? "text-green-400 hover:text-green-300"
                            : "text-red-400 hover:text-red-300"
                        )}
                      >
                        {isBlocked ? "Unblock" : "Block"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-12 text-muted-text">
                  {search
                    ? "No tokens match your search"
                    : "No tokens loaded. Run the bot to populate the token list."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex flex-col sm:flex-row items-center justify-between border-t border-divider-color px-4 py-4 bg-card-bg/30 mt-4 rounded-xl gap-4">
          <div className="text-xs text-muted-text">
            Showing <span className="font-semibold text-title-text">{startIndex + 1}</span> to{" "}
            <span className="font-semibold text-title-text">
              {Math.min(startIndex + ITEMS_PER_PAGE, filtered.length)}
            </span>{" "}
            of <span className="font-semibold text-title-text">{filtered.length}</span> tokens
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className={classNames(
                "px-3 py-1.5 rounded-lg text-xs font-semibold border border-divider-color transition-colors cursor-pointer",
                page === 1
                  ? "opacity-40 cursor-not-allowed text-muted-text"
                  : "text-title-text hover:bg-bg-hover"
              )}
            >
              Previous
            </button>
            <div className="flex items-center gap-1">
              {getPageNumbers().map((p, idx) => {
                if (p === "...") {
                  return (
                    <span key={`dots-${idx}`} className="px-2 text-xs text-muted-text select-none">
                      ...
                    </span>
                  );
                }
                return (
                  <button
                    key={p}
                    onClick={() => setPage(p as number)}
                    className={classNames(
                      "w-8 h-8 rounded-lg text-xs font-bold transition-all duration-200 cursor-pointer flex items-center justify-center",
                      page === p
                        ? "bg-brand-500 text-white shadow-lg shadow-brand-500/25"
                        : "text-muted-text hover:text-title-text hover:bg-bg-hover"
                    )}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className={classNames(
                "px-3 py-1.5 rounded-lg text-xs font-semibold border border-divider-color transition-colors cursor-pointer",
                page === totalPages
                  ? "opacity-40 cursor-not-allowed text-muted-text"
                  : "text-title-text hover:bg-bg-hover"
              )}
            >
              Next
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 text-xs text-muted-text/80">
        Blocked tokens are excluded from portfolio balances, rebalancing, and
        market making. STX cannot be blocked.
      </div>
    </div>
  );
}
