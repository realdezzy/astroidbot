import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Wallet, PieChart } from "lucide-react";
import { apiFetch } from "../lib/api";
import { formatUSD, formatNumber, classNames } from "../lib/utils";
import { PortfolioChart } from "../components/PortfolioChart";
import { TradingViewChart } from "../components/TradingViewChart";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import { AutoRefreshToggle } from "../components/AutoRefreshToggle";

interface WalletType {
  id: number;
  address: string;
  name: string;
  balance: number;
  balanceUsd: number;
}

interface AnalyticsData {
  summary: { totalTrades: number; totalVolume: number; totalProfit: number };
  chartData: Array<{ date: string; pnl: number; volume: number; buys: number; sells: number }>;
}

const COLORS = ["#6366f1", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#2dd4bf"];

export function Portfolio() {
  const [activeTab, setActiveTab] = useState<number | "all">("all");
  const { isActive, toggle, timeLeft, interval } = useAutoRefresh("portfolio");

  const { data: wallets } = useQuery<WalletType[]>({
    queryKey: ["wallets"],
    queryFn: () => apiFetch("/me/wallets"),
    refetchInterval: interval,
  });

  const { data: analytics } = useQuery<AnalyticsData>({
    queryKey: ["analytics"],
    queryFn: () => apiFetch("/me/analytics"),
    refetchInterval: interval,
  });

  const allWallets = wallets ?? [];
  const selectedWallet = activeTab === "all" ? null : allWallets.find((w) => w.id === activeTab);
  const filteredWallets = selectedWallet ? [selectedWallet] : allWallets;

  const totalBalance = filteredWallets.reduce((sum, w) => sum + (w.balanceUsd ?? 0), 0);

  const chartData = filteredWallets.map((w, i) => ({
    name: w.name,
    value: w.balanceUsd ?? 0,
    color: COLORS[i % 6],
  }));

  const pnlData = analytics?.chartData?.map((d) => ({ time: d.date, value: d.pnl })) ?? [];
  const volumeData = analytics?.chartData?.map((d) => ({ time: d.date, value: d.volume })) ?? [];

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-title-text">Portfolio</h2>
          <p className="text-muted-text mt-1 text-sm">
            {selectedWallet ? selectedWallet.name : "All wallets"} · Asset allocation & performance
          </p>
        </div>
        <div className="flex items-center gap-3">
          <AutoRefreshToggle isActive={isActive} toggle={toggle} timeLeft={timeLeft} />
        </div>
      </div>

      {/* Wallet Tabs */}
      {allWallets.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 mb-6">
          <TabButton active={activeTab === "all"} onClick={() => setActiveTab("all")} label="All Wallets" />
          {allWallets.map((w) => (
            <TabButton
              key={w.id}
              active={activeTab === w.id}
              onClick={() => setActiveTab(w.id)}
              label={w.name}
              subtitle={`${formatUSD(w.balanceUsd ?? 0)}`}
            />
          ))}
        </div>
      )}

      {/* Portfolio Value Hero */}
      <div className="glass-card p-8 mb-6">
        <div className="flex items-center gap-2 mb-2">
          <Wallet className="w-5 h-5 text-brand-400" />
          <span className="text-sm text-muted-text uppercase tracking-wider font-semibold">Portfolio Value</span>
        </div>
        <span className="text-4xl font-bold text-title-text">{formatUSD(totalBalance)}</span>
        <div className="mt-3 flex flex-wrap gap-4 text-sm text-muted-text">
          <span>{filteredWallets.length} wallet{filteredWallets.length !== 1 ? "s" : ""}</span>
          <span>·</span>
          <span>{analytics?.summary.totalTrades ?? 0} trades</span>
          <span>·</span>
          <span>Vol: {formatNumber(analytics?.summary.totalVolume ?? 0, 0)} STX</span>
        </div>
      </div>

      {/* Allocation + PnL Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="glass-card p-6">
          <div className="flex items-center gap-2 mb-6">
            <PieChart className="w-4 h-4 text-brand-400" />
            <h3 className="text-sm font-bold text-title-text uppercase tracking-wider">Allocation</h3>
          </div>
          <PortfolioChart data={chartData} totalValue={totalBalance} />
          <div className="mt-4 space-y-2">
            {filteredWallets.map((w, i) => (
              <div key={w.id} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: COLORS[i % 6] }} />
                  <span className="text-muted-text font-medium">{w.name}</span>
                </div>
                <span className="text-title-text font-bold">{formatUSD(w.balanceUsd ?? 0)} ({w.balance.toFixed(2)} STX)</span>
              </div>
            ))}
          </div>
        </div>

        <div className="glass-card p-6">
          <TradingViewChart type="area" data={pnlData} height={300} color="#4f46e5" title="Cumulative PnL" />
        </div>
      </div>

      {/* Volume Chart */}
      <div className="glass-card p-6 mb-6">
        <TradingViewChart type="histogram" data={volumeData} height={200} color="#34d399" title="Daily Trade Volume" />
      </div>

      {/* Wallet Breakdown Cards */}
      {filteredWallets.length > 0 && (
        <div className="glass-card p-6">
          <h3 className="text-sm font-bold text-title-text uppercase tracking-wider mb-4">Wallet Balances</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredWallets.map((w) => (
              <div key={w.id} className="p-4 rounded-xl border border-divider-color bg-bg-hover">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-title-text text-sm">{w.name}</span>
                </div>
                <div className="flex items-center gap-1 mb-1">
                  <span className="text-xs text-muted-text font-mono">
                    {w.address.slice(0, 6)}...{w.address.slice(-4)}
                  </span>
                </div>
                <div className="flex items-baseline gap-2 mt-2">
                  <span className="text-2xl font-bold text-title-text">{formatUSD(w.balanceUsd ?? 0)}</span>
                  <span className="text-xs text-muted-text">({w.balance.toFixed(2)} STX)</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  subtitle?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={classNames(
        "px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 border",
        active
          ? "bg-brand-500/15 border-brand-500/40 text-brand-400"
          : "border-divider-color bg-bg-hover text-muted-text hover:text-title-text hover:bg-input-bg"
      )}
    >
      <span>{label}</span>
      {subtitle && <span className="ml-2 text-xs opacity-60">{subtitle}</span>}
    </button>
  );
}
