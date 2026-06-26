import { useQuery } from "@tanstack/react-query";
import {
  TrendingUp,
  TrendingDown,
  Wallet,
  Activity,
  RefreshCw,
  ArrowRightLeft,
  Bot,
  PieChart,
  Zap,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { formatUSD, formatNumber } from "../lib/utils";
import { StatusBadge } from "../components/StatusBadge";
import { AutoRefreshToggle } from "../components/AutoRefreshToggle";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import { ChatInput } from "../components/ChatInput";

interface BotStatus {
  status: string;
  haltedReason: string | null;
}

interface Wallet {
  id: number;
  address: string;
  name: string;
  balance: number;
  balanceUsd: number;
}

interface TradeSummary {
  items: Array<{
    direction: string;
    amountIn: number;
    amountOut: number;
    status: string;
    tokenIn: string;
    tokenOut: string;
  }>;
  total: number;
}

export function Dashboard() {
  const navigate = useNavigate();
  const { isActive, toggle, timeLeft, interval } = useAutoRefresh("dashboard");

  const { data: status } = useQuery<BotStatus>({
    queryKey: ["bot-status"],
    queryFn: () => apiFetch("/bot/status"),
    refetchInterval: isActive ? 10_000 : false,
  });

  const { data: wallets } = useQuery<Wallet[]>({
    queryKey: ["wallets"],
    queryFn: () => apiFetch("/me/wallets"),
    refetchInterval: interval,
  });

  const { data: trades } = useQuery<TradeSummary>({
    queryKey: ["trades-summary"],
    queryFn: () => apiFetch("/me/trades?limit=10"),
    refetchInterval: interval,
  });

  const totalBalance = wallets?.reduce((sum, w) => sum + w.balanceUsd, 0) ?? 0;
  const confirmedTrades =
    trades?.items.filter((t) => t.status === "CONFIRMED") ?? [];
  const pendingTrades =
    trades?.items.filter(
      (t) => t.status === "PENDING" || t.status === "BROADCAST"
    ) ?? [];

  const dailyPnl = confirmedTrades.reduce((sum, t) => {
    if (t.direction === "BUY") return sum - t.amountIn;
    return sum + (t.amountOut - t.amountIn);
  }, 0);

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <h2 className="text-2xl font-bold text-title-text">Dashboard</h2>
          <p className="text-muted-text mt-1 text-sm">Your trading command center</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <AutoRefreshToggle isActive={isActive} toggle={toggle} timeLeft={timeLeft} />
          {status && (
            <>
              <StatusBadge status={status.status} />
              {status.haltedReason && (
                <span className="text-sm text-muted-text">{status.haltedReason}</span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Portfolio Value Hero */}
      <div className="glass-card p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Wallet className="w-4 h-4 text-brand-400" />
              <span className="text-xs text-muted-text uppercase tracking-wider font-semibold">
                Portfolio Value
              </span>
            </div>
            <span className="text-3xl font-bold text-title-text">
              {formatUSD(totalBalance)}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => navigate("/trade")}
              className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              <ArrowRightLeft className="w-4 h-4" /> Trade
            </button>
            <button
              onClick={() => navigate("/portfolio")}
              className="px-4 py-2 border border-divider-color bg-bg-hover hover:bg-input-bg text-title-text rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              <PieChart className="w-4 h-4" /> Portfolio
            </button>
            <button
              onClick={() => navigate("/agents")}
              className="px-4 py-2 border border-divider-color bg-bg-hover hover:bg-input-bg text-title-text rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              <Bot className="w-4 h-4" /> Agents
            </button>
          </div>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          icon={Activity}
          label="Bot Status"
          value={status?.status ?? "IDLE"}
          badge
        />
        <StatCard
          icon={RefreshCw}
          label="Active Trades"
          value={String(pendingTrades.length)}
        />
        <StatCard
          icon={Zap}
          label="Confirmed Today"
          value={String(confirmedTrades.length)}
        />
        <StatCard
          icon={dailyPnl >= 0 ? TrendingUp : TrendingDown}
          label="Daily PnL"
          value={`${dailyPnl >= 0 ? "+" : ""}${formatNumber(dailyPnl, 2)} STX`}
          trend={dailyPnl >= 0 ? "up" : "down"}
        />
      </div>

      {/* Recent Trades */}
      <div className="glass-card p-6 overflow-x-auto">
        <h3 className="text-sm font-bold text-title-text uppercase tracking-wider mb-4">
          Recent Trades
        </h3>
        {trades && trades.items.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-text border-b border-divider-color">
                <th className="text-left py-2 font-semibold">Direction</th>
                <th className="text-left py-2 font-semibold">Amount In</th>
                <th className="text-left py-2 font-semibold">Amount Out</th>
                <th className="text-left py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {trades.items.slice(0, 8).map((trade, i) => (
                <tr key={i} className="border-b border-divider-color hover:bg-bg-hover transition-colors">
                  <td className="py-2.5">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded ${trade.direction === "BUY" ? "text-green-400 bg-green-500/10" : "text-red-400 bg-red-500/10"}`}>
                      {trade.direction}
                    </span>
                  </td>
                  <td className="py-2.5 text-title-text font-mono">
                    {trade.amountIn.toFixed(4)} {trade.tokenIn}
                  </td>
                  <td className="py-2.5 text-title-text font-mono">
                    {trade.amountOut.toFixed(4)} {trade.tokenOut}
                  </td>
                  <td className="py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${trade.status === "CONFIRMED" ? "text-green-400 bg-green-500/10" : trade.status === "FAILED" ? "text-red-400 bg-red-500/10" : "text-yellow-400 bg-yellow-500/10"}`}>
                      {trade.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-center py-8 text-muted-text font-semibold">
            No trades yet. Start the bot to begin trading.
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  trend,
  badge,
}: {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string;
  trend?: "up" | "down" | null;
  badge?: boolean;
}) {
  return (
    <div className="glass-card p-5">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-muted-text" />
        <span className="text-xs text-muted-text uppercase tracking-wider font-semibold">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        {badge ? (
          <StatusBadge status={value} />
        ) : (
          <span className={`text-2xl font-bold ${trend === "up" ? "text-green-400" : trend === "down" ? "text-red-400" : "text-title-text"}`}>
            {value}
          </span>
        )}
      </div>
    </div>
  );
}
