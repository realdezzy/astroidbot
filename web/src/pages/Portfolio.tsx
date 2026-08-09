import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Wallet, PieChart } from "lucide-react";
import { apiFetch } from "../lib/api";
import { formatUSD, formatNumber, classNames } from "../lib/utils";
import { PortfolioChart } from "../components/PortfolioChart";
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, Tooltip, XAxis, YAxis } from "recharts";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import { AutoRefreshToggle } from "../components/AutoRefreshToggle";
import { ChainBadge } from "../components/ChainBadge";
import { useChains, chainLabel, nativeSymbolOf } from "../hooks/useChains";

interface WalletType {
  id: number;
  address: string;
  name: string;
  balance: number;
  balanceUsd: number;
  /** ChainId. Two wallets on different chains never share an asset row. */
  chain?: string | null;
  balances?: Array<{
    token: string;
    symbol: string;
    balance: number;
    usdValue: number;
  }>;
}

interface AnalyticsData {
  summary: { totalTrades: number; totalVolume: number; totalProfit: number };
  chartData: Array<{ date: string; timestamp: number; pnl: number; volume: number; buys: number; sells: number }>;
}

const COLORS = ["#6366f1", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#2dd4bf"];

export function Portfolio() {
  const [activeTab, setActiveTab] = useState<number | "all">("all");
  const [timeframe, setTimeframe] = useState<"1d" | "7d" | "30d" | "all">("7d");
  const { isActive, toggle, timeLeft, interval } = useAutoRefresh("portfolio");
  const { chains } = useChains();

  const { data: wallets } = useQuery<WalletType[]>({
    queryKey: ["wallets"],
    queryFn: () => apiFetch("/me/wallets"),
    refetchInterval: interval,
  });

  const { data: analytics } = useQuery<AnalyticsData>({
    queryKey: ["analytics", activeTab, timeframe],
    queryFn: () => {
      let url = activeTab === "all" ? "/me/analytics" : `/me/analytics?walletId=${activeTab}`;
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}timeframe=${timeframe}`;
      return apiFetch(url);
    },
    refetchInterval: interval,
  });

  const allWallets = wallets ?? [];
  const selectedWallet = activeTab === "all" ? null : allWallets.find((w) => w.id === activeTab);
  const filteredWallets = selectedWallet ? [selectedWallet] : allWallets;

  const totalBalance = filteredWallets.reduce((sum, w) => sum + (w.balanceUsd ?? 0), 0);

  // Combine balances of the same token across the selected wallets.
  //
  // Keyed by `chainId:symbol`, never by the bare symbol. USDC on Base and USDC
  // on Solana are different assets that cannot be moved between each other, and
  // summing them produced a holding the user does not have — one row, one
  // balance, no way to act on it. Same rule the backend catalogue follows.
  const assetBalances: Record<
    string,
    { symbol: string; balance: number; usdValue: number; token: string; chain?: string | null }
  > = {};

  filteredWallets.forEach((w) => {
    const wBalances = w.balances || [
      {
        token: nativeSymbolOf(w.chain, chains),
        symbol: nativeSymbolOf(w.chain, chains),
        balance: w.balance,
        usdValue: w.balanceUsd,
      },
    ];
    wBalances.forEach((b) => {
      const key = `${w.chain ?? "unknown"}:${b.symbol.toUpperCase()}`;
      if (assetBalances[key]) {
        assetBalances[key].balance += b.balance;
        assetBalances[key].usdValue += b.usdValue ?? 0;
      } else {
        assetBalances[key] = {
          token: b.token,
          symbol: b.symbol,
          balance: b.balance,
          usdValue: b.usdValue ?? 0,
          chain: w.chain,
        };
      }
    });
  });

  const assetsList = Object.values(assetBalances)
    .filter((a) => a.balance > 0)
    .sort((a, b) => b.usdValue - a.usdValue);

  const totalAssetValue = assetsList.reduce((sum, a) => sum + a.usdValue, 0);

  // Slice labels carry the chain when more than one is in play, so two USDC
  // wedges are tellable apart.
  const multiChain = new Set(filteredWallets.map((w) => w.chain)).size > 1;
  const chartData = assetsList.map((a, i) => ({
    name: multiChain ? `${a.symbol} · ${chainLabel(a.chain, chains)}` : a.symbol,
    value: a.usdValue,
    color: COLORS[i % COLORS.length],
  }));

  const pnlData = analytics?.chartData?.map((d) => ({
    time: timeframe === "1d" ? Math.floor(d.timestamp / 1000) : d.date,
    value: d.pnl
  })) ?? [];
  const volumeData = analytics?.chartData?.map((d) => ({
    time: timeframe === "1d" ? Math.floor(d.timestamp / 1000) : d.date,
    value: d.volume
  })) ?? [];

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
          <span>Vol: {formatUSD(analytics?.summary.totalVolume ?? 0)}</span>
        </div>
      </div>

      {/* Allocation + PnL Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="glass-card p-6">
          <div className="flex items-center gap-2 mb-6">
            <PieChart className="w-4 h-4 text-brand-400" />
            <h3 className="text-sm font-bold text-title-text uppercase tracking-wider">Allocation</h3>
          </div>
          <PortfolioChart data={chartData} totalValue={totalAssetValue} />
          <div className="mt-4 space-y-2 max-h-60 overflow-y-auto pr-1">
            {assetsList.map((a, i) => {
              const allocationPct = totalAssetValue > 0 ? (a.usdValue / totalAssetValue) * 100 : 0;
              return (
                <div key={`${a.chain}:${a.token}`} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                    <span className="text-muted-text font-medium">{a.symbol}</span>
                    {multiChain && a.chain && <ChainBadge chainId={a.chain} />}
                  </div>
                  <span className="text-title-text font-bold">
                    {formatUSD(a.usdValue)} ({allocationPct.toFixed(1)}%)
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="glass-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-title-text uppercase tracking-wider">Cumulative PnL</h3>
            <div className="flex items-center gap-1 bg-bg-hover p-1 rounded-xl border border-divider-color">
              {(["1d", "7d", "30d", "all"] as const).map((tf) => (
                <button
                  key={tf}
                  onClick={() => setTimeframe(tf)}
                  className={classNames(
                    "px-3 py-1 text-xs font-semibold rounded-lg transition-all uppercase",
                    timeframe === tf
                      ? "bg-brand-500 text-white shadow-sm"
                      : "text-muted-text hover:text-title-text"
                  )}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>
          <div className="h-[260px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={pnlData}>
                <defs>
                  <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" stroke="#64748b" fontSize={10} tickLine={false} />
                <YAxis stroke="#64748b" fontSize={10} tickLine={false} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1e293b",
                    borderColor: "#334155",
                    borderRadius: "8px",
                    color: "#f8fafc",
                  }}
                  formatter={(val: number) => [`$${val.toFixed(2)}`, "PnL"]}
                />
                <Area type="monotone" dataKey="value" stroke="#6366f1" strokeWidth={2} fillOpacity={1} fill="url(#pnlGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Volume Chart */}
      <div className="glass-card p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-title-text uppercase tracking-wider">Trade Volume</h3>
          <span className="text-xs text-muted-text font-semibold uppercase">{timeframe} Timeframe</span>
        </div>
        <div className="h-[180px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={volumeData}>
              <XAxis dataKey="time" stroke="#64748b" fontSize={10} tickLine={false} />
              <YAxis stroke="#64748b" fontSize={10} tickLine={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#1e293b",
                  borderColor: "#334155",
                  borderRadius: "8px",
                  color: "#f8fafc",
                }}
                formatter={(val: number) => [`$${val.toFixed(2)}`, "Volume"]}
              />
              <Bar dataKey="value" fill="#34d399" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Asset Breakdown Table */}
      {assetsList.length > 0 && (
        <div className="glass-card p-6 mb-6">
          <h3 className="text-sm font-bold text-title-text uppercase tracking-wider mb-4">Asset Breakdown</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-divider-color text-sm text-left">
              <thead>
                <tr className="text-muted-text font-semibold">
                  <th className="pb-3 pr-4">Asset</th>
                  <th className="pb-3 px-4">Price</th>
                  <th className="pb-3 px-4">Balance</th>
                  <th className="pb-3 px-4">USD Value</th>
                  <th className="pb-3 pl-4 text-right">Allocation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divider-color">
                {assetsList.map((a) => {
                  const allocationPct = totalAssetValue > 0 ? (a.usdValue / totalAssetValue) * 100 : 0;
                  const tokenPrice = a.balance > 0 ? a.usdValue / a.balance : 0;
                  return (
                    <tr key={`${a.chain}:${a.token}`} className="text-title-text hover:bg-bg-hover transition-colors">
                      <td className="py-4 pr-4 font-medium flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-brand-500/10 text-brand-400 flex items-center justify-center font-bold text-xs uppercase">
                          {a.symbol.slice(0, 3)}
                        </div>
                        <div>
                          <div className="font-semibold flex items-center gap-1.5">
                            {a.symbol}
                            {multiChain && a.chain && <ChainBadge chainId={a.chain} />}
                          </div>
                          <div className="text-xs text-muted-text max-w-[150px] truncate font-mono" title={a.token}>
                            {a.token.includes("::") ? `${a.token.slice(0, 6)}...${a.token.split("::")[1]}` : a.token}
                          </div>
                        </div>
                      </td>
                      <td className="py-4 px-4 font-mono">{formatUSD(tokenPrice)}</td>
                      <td className="py-4 px-4 font-mono">{formatNumber(a.balance, 4)}</td>
                      <td className="py-4 px-4 font-semibold font-mono">{formatUSD(a.usdValue)}</td>
                      <td className="py-4 pl-4 text-right font-semibold text-brand-400 font-mono">
                        {allocationPct.toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Wallet Breakdown Cards */}
      {filteredWallets.length > 0 && (
        <div className="glass-card p-6">
          <h3 className="text-sm font-bold text-title-text uppercase tracking-wider mb-4">Wallet Balances</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredWallets.map((w) => (
              <div key={w.id} className="p-4 rounded-xl border border-divider-color bg-bg-hover">
                <div className="flex items-center justify-between mb-2 gap-2">
                  <span className="font-semibold text-title-text text-sm">{w.name}</span>
                  {w.chain && <ChainBadge chainId={w.chain} />}
                </div>
                <div className="flex items-center gap-1 mb-1">
                  <span className="text-xs text-muted-text font-mono">
                    {w.address.slice(0, 6)}...{w.address.slice(-4)}
                  </span>
                </div>
                <div className="flex items-baseline gap-2 mt-2">
                  <span className="text-2xl font-bold text-title-text">{formatUSD(w.balanceUsd ?? 0)}</span>
                  <span className="text-xs text-muted-text">
                    ({w.balance.toFixed(2)} {nativeSymbolOf(w.chain, chains)})
                  </span>
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
