import { useQuery } from "@tanstack/react-query";
import { X, TrendingUp, TrendingDown, ExternalLink, Loader2 } from "lucide-react";
import { apiFetch } from "../lib/api";
import { formatDate, formatNumber, classNames } from "../lib/utils";

interface StrategyDetailProps {
  strategyId: number;
  onClose: () => void;
}

interface DetailData {
  strategy: {
    id: number; type: string; config: Record<string, unknown>;
    isActive: boolean; createdAt: string; updatedAt: string;
  };
  trades: Array<{
    id: number; direction: string;
    tokenIn: string; tokenOut: string;
    amountIn: number; amountOut: number;
    feeAmount: number; feeBps: number;
    txId: string | null; status: string;
    createdAt: string; confirmedAt: string | null;
  }>;
  pnl: number;
  totalTrades: number;
}

const STATUS_COLORS: Record<string, string> = {
  CONFIRMED: "text-green-400 bg-green-500/10",
  BROADCAST: "text-yellow-400 bg-yellow-500/10",
  PENDING: "text-gray-400 bg-gray-500/10",
  FAILED: "text-red-400 bg-red-500/10",
};

export function StrategyDetailModal({ strategyId, onClose }: StrategyDetailProps) {
  const { data, isLoading } = useQuery<DetailData>({
    queryKey: ["strategy-detail", strategyId],
    queryFn: () => apiFetch(`/me/strategies/${strategyId}/detail`),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-card-bg border border-card-border rounded-3xl w-full max-w-2xl max-h-[80vh] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-divider-color">
          <div>
            <h3 className="text-lg font-bold text-title-text">
              {data?.strategy.type.replace(/_/g, " ") ?? "Strategy"} Details
            </h3>
            <p className="text-xs text-muted-text mt-0.5">
              Created {data ? formatDate(data.strategy.createdAt) : "..."}
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-bg-hover rounded-xl transition-colors text-muted-text hover:text-title-text">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(80vh-80px)]">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-text" />
            </div>
          ) : data ? (
            <div className="space-y-6">
              {/* PnL Card */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-input-bg/50 rounded-2xl p-4 text-center">
                  <p className="text-xs text-muted-text uppercase tracking-wider mb-1">Total Trades</p>
                  <p className="text-2xl font-bold text-title-text">{data.totalTrades}</p>
                </div>
                <div className="bg-input-bg/50 rounded-2xl p-4 text-center">
                  <p className="text-xs text-muted-text uppercase tracking-wider mb-1">PnL</p>
                  <p className={classNames(
                    "text-2xl font-bold",
                    data.pnl >= 0 ? "text-green-400" : "text-red-400"
                  )}>
                    {data.pnl >= 0 ? "+" : ""}{formatNumber(data.pnl, 2)}
                  </p>
                </div>
                <div className="bg-input-bg/50 rounded-2xl p-4 text-center">
                  <p className="text-xs text-muted-text uppercase tracking-wider mb-1">Status</p>
                  <span className={classNames(
                    "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium",
                    data.strategy.isActive ? "text-green-400 bg-green-500/10" : "text-muted-text bg-muted-text/10"
                  )}>
                    {data.strategy.isActive ? "Active" : "Paused"}
                  </span>
                </div>
              </div>

              {/* Config */}
              <div>
                <h4 className="text-sm font-semibold text-muted-text uppercase tracking-wider mb-2">Config</h4>
                <div className="bg-input-bg/50 rounded-2xl p-4 grid grid-cols-2 gap-2 text-xs">
                  {Object.entries(data.strategy.config).map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span className="text-muted-text">{k}</span>
                      <span className="text-title-text">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Trades */}
              <div>
                <h4 className="text-sm font-semibold text-muted-text uppercase tracking-wider mb-2">
                  Recent Trades ({data.trades.length})
                </h4>
                {data.trades.length === 0 ? (
                  <p className="text-xs text-muted-text/60 py-4 text-center">No trades yet</p>
                ) : (
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {data.trades.slice(0, 20).map((t) => (
                      <div key={t.id} className="flex items-center justify-between bg-input-bg/30 rounded-xl px-4 py-2.5 text-xs">
                        <div className="flex items-center gap-3">
                          <span className={classNames(
                            "px-1.5 py-0.5 rounded font-medium",
                            t.direction === "BUY" ? "text-green-400 bg-green-500/10" : "text-red-400 bg-red-500/10"
                          )}>
                            {t.direction}
                          </span>
                          <span className="text-title-text font-mono">
                            {formatNumber(t.amountIn, 4)} {t.tokenIn} → {formatNumber(t.amountOut, 4)} {t.tokenOut}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className={STATUS_COLORS[t.status] ?? "text-muted-text"}>
                            {t.status}
                          </span>
                          {t.txId && (
                            <a
                              href={`https://explorer.hiro.so/txid/${t.txId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-brand-400 hover:text-brand-300"
                            >
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                          <span className="text-muted-text/60">{formatDate(t.createdAt)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-text">Could not load strategy details</div>
          )}
        </div>
      </div>
    </div>
  );
}
