import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { TradeRow } from "../../components/TradeRow";
import { AutoRefreshToggle } from "../../components/AutoRefreshToggle";
import { useAutoRefresh } from "../../hooks/useAutoRefresh";

interface TradesResponse {
  items: Array<{
    id: number;
    direction: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: number;
    amountOut: number;
    txId: string | null;
    status: string;
    errorMessage: string | null;
    createdAt: string;
    confirmedAt: string | null;
    walletName: string;
    walletAddress: string;
  }>;
  total: number;
  page: number;
  limit: number;
}

export function TradeHistory() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const limit = 20;
  const { isActive, toggle, timeLeft, interval } = useAutoRefresh("trades");

  const { data, isLoading } = useQuery<TradesResponse>({
    queryKey: ["trades", page, statusFilter],
    queryFn: () =>
      apiFetch(
        `/me/trades?page=${page}&limit=${limit}${statusFilter ? `&status=${statusFilter}` : ""}`
      ),
    refetchInterval: interval,
  });

  const totalPages = data ? Math.ceil(data.total / limit) : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-xl font-bold text-title-text">Trade History</h2>
          <p className="text-muted-text mt-1 text-sm">Execution logs for all trades</p>
        </div>
        <div className="flex items-center gap-2">
          <AutoRefreshToggle
            isActive={isActive}
            toggle={toggle}
            timeLeft={timeLeft}
          />
          {["", "PENDING", "BROADCAST", "CONFIRMED", "FAILED"].map((s) => (
            <button
              key={s}
              onClick={() => {
                setStatusFilter(s);
                setPage(1);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === s
                  ? "bg-brand-500/20 text-brand-400"
                  : "text-muted-text hover:text-title-text hover:bg-bg-hover"
              }`}
            >
              {s || "All"}
            </button>
          ))}
        </div>
      </div>

      <div className="glass-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-divider-color text-muted-text">
                <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                  Date
                </th>
                <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                  Direction
                </th>
                <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                  Amount In
                </th>
                <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                  Amount Out
                </th>
                <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                  Fee
                </th>
                <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                  Status
                </th>
                <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                  TX
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="text-center py-12 text-muted-text">
                    Loading trades...
                  </td>
                </tr>
              ) : data && data.items.length > 0 ? (
                data.items.map((trade) => (
                  <TradeRow key={trade.id} trade={trade} />
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="text-center py-12 text-muted-text">
                    No trades found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-divider-color">
            <span className="text-sm text-muted-text">
              {data?.total ?? 0} total trades
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="p-1.5 rounded-lg text-muted-text hover:text-title-text hover:bg-bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm text-muted-text px-2">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="p-1.5 rounded-lg text-muted-text hover:text-title-text hover:bg-bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
