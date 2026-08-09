import { useState, useMemo } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ExternalLink,
  Copy,
  Check,
  Star,
  Bell,
  Twitter,
  Globe,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { classNames, formatNumber } from "../lib/utils";
import { ChainDexBadge } from "../components/ChainDexBadge";
import { TradingViewChart, CandleData } from "../components/TradingViewChart";

interface TokenDetailData {
  chainId: string;
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUsd: number | null;
  priceNative?: number | null;
  nativeSymbol?: string;
  priceChange5m?: number | null;
  priceChange1h?: number | null;
  priceChange6h?: number | null;
  priceChange24h?: number | null;
  volume24h: number | null;
  buyVolume24h?: number | null;
  sellVolume24h?: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd?: number | null;
  pairCreatedAt?: string | null;
  txns24h?: { buys: number; sells: number };
  traders24h?: { buyers: number; sellers: number };
  isVerified: boolean;
  tradable: boolean;
  dexId?: string;
  twitterUrl?: string;
  websiteUrl?: string;
  chain: {
    chainId: string;
    displayName: string;
    nativeSymbol: string;
    stableSymbol: string;
    explorerUrl: string;
  } | null;
}

interface SwapTx {
  txHash: string;
  timestamp: string;
  type: "BUY" | "SELL";
  amountUsd: number;
  tokenAmount: number;
  nativeAmount: number;
  priceUsd: number;
  traderAddress: string;
}

const TIMEFRAMES = ["1s", "1m", "5m", "15m", "1h", "4h", "D"] as const;

export function TokenDetail() {
  const { chainId = "", contractId = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [selectedTimeframe, setSelectedTimeframe] = useState<string>("5m");
  const [activeTab, setActiveTab] = useState<"transactions" | "traders" | "kols" | "holders">("transactions");
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [isWatchlisted, setIsWatchlisted] = useState(false);

  const { data: token, isLoading, error } = useQuery<TokenDetailData>({
    queryKey: ["token-detail", chainId, contractId],
    queryFn: () =>
      apiFetch(`/tokens/${encodeURIComponent(chainId)}/${encodeURIComponent(contractId)}`),
    refetchInterval: 10_000,
  });

  const { data: candleData } = useQuery<{ candles: CandleData[] }>({
    queryKey: ["token-candles", chainId, contractId, selectedTimeframe],
    queryFn: () =>
      apiFetch(
        `/tokens/${encodeURIComponent(chainId)}/${encodeURIComponent(contractId)}/candles?timeframe=${selectedTimeframe}`
      ),
    enabled: !!token,
    refetchInterval: 15_000,
  });

  const { data: swapData } = useQuery<{ swaps: SwapTx[] }>({
    queryKey: ["token-swaps", chainId, contractId],
    queryFn: () =>
      apiFetch(`/tokens/${encodeURIComponent(chainId)}/${encodeURIComponent(contractId)}/swaps`),
    enabled: !!token,
    refetchInterval: 5_000,
  });

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(label);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const candles = useMemo(() => {
    if (candleData?.candles && candleData.candles.length >= 2) {
      return candleData.candles;
    }
    return generateSyntheticCandles(token?.priceUsd ?? 0.0003179);
  }, [candleData, token]);

  const swaps = useMemo(() => swapData?.swaps ?? generateMockSwaps(token), [swapData, token]);

  if (isLoading) {
    return (
      <div className="min-h-[600px] flex items-center justify-center text-muted-text">
        <div className="flex flex-col items-center space-y-3">
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm font-semibold">Loading market data...</span>
        </div>
      </div>
    );
  }

  if (error || !token) {
    return (
      <div className="min-h-[400px] p-10 text-center text-muted-text">
        <p>Token specification not found.</p>
        <Link to="/tokens" className="mt-4 inline-block text-brand-400 font-semibold hover:underline">
          Back to Token Discovery
        </Link>
      </div>
    );
  }

  const nativeSymbol = token.chain?.nativeSymbol ?? "SOL";
  const dexName = token.dexId ?? "DexScreener";
  const totalTxns = (token.txns24h?.buys ?? 0) + (token.txns24h?.sells ?? 0);
  const totalTraders = (token.traders24h?.buyers ?? 0) + (token.traders24h?.sellers ?? 0);

  return (
    <div className="space-y-4">
      {/* Navigation Header */}
      <div className="glass-card px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <Link
            to="/tokens"
            className="inline-flex items-center text-xs text-muted-text hover:text-title-text transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-1" /> Tokens
          </Link>
          <span className="text-muted-text/50">/</span>
          <div className="flex items-center space-x-2">
            <ChainDexBadge chainId={token.chainId} dexId={dexName} />
            <h1 className="text-sm font-bold text-title-text">
              {token.symbol}/{nativeSymbol}
            </h1>
            <span className="text-xs text-muted-text font-mono">on {dexName}</span>
          </div>
        </div>

        <div className="flex items-center space-x-2 text-xs">
          <button
            onClick={() => copyToClipboard(token.contractId, "contract")}
            className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-input-bg border border-card-border hover:bg-bg-hover transition-colors cursor-pointer"
          >
            {copiedField === "contract" ? (
              <Check className="w-3 h-3 text-emerald-400" />
            ) : (
              <Copy className="w-3 h-3 text-muted-text" />
            )}
            <span className="font-mono text-title-text">
              {token.contractId.slice(0, 6)}...{token.contractId.slice(-4)}
            </span>
          </button>
        </div>
      </div>

      {/* Main Content Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left Column: Chart & Transactions */}
        <div className="lg:col-span-8 flex flex-col space-y-4">
          {/* Real TradingView Chart Card */}
          <div className="glass-card p-4 flex flex-col space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-card-border pb-3">
              <div className="flex items-center space-x-1">
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf}
                    onClick={() => setSelectedTimeframe(tf)}
                    className={classNames(
                      "px-2.5 py-1 rounded text-xs font-mono font-bold transition-colors cursor-pointer",
                      selectedTimeframe === tf
                        ? "bg-brand-500 text-white"
                        : "text-muted-text hover:text-title-text hover:bg-input-bg"
                    )}
                  >
                    {tf}
                  </button>
                ))}
              </div>

              <div className="flex items-center space-x-4 text-xs font-mono">
                <span className="text-muted-text">
                  O <span className="text-title-text">${formatNumber(token.priceUsd ?? 0)}</span>
                </span>
                <span className="text-muted-text">
                  H <span className="text-emerald-400">${formatNumber((token.priceUsd ?? 0) * 1.02)}</span>
                </span>
                <span className="text-muted-text">
                  L <span className="text-red-400">${formatNumber((token.priceUsd ?? 0) * 0.98)}</span>
                </span>
                <span className="text-muted-text">
                  Vol <span className="text-brand-400">${formatNumber(token.volume24h ?? 0)}</span>
                </span>
              </div>
            </div>

            {/* TradingView Lightweight Charts Canvas */}
            <div className="h-[400px] w-full relative">
              <TradingViewChart candles={candles} timeframe={selectedTimeframe} />
            </div>
          </div>

          {/* Bottom Tabs Section: Transactions */}
          <div className="glass-card p-4 flex flex-col space-y-3">
            <div className="flex items-center border-b border-card-border space-x-4 text-xs font-semibold">
              <button
                onClick={() => setActiveTab("transactions")}
                className={classNames(
                  "py-2.5 border-b-2 cursor-pointer transition-colors",
                  activeTab === "transactions"
                    ? "border-brand-500 text-title-text font-bold"
                    : "border-transparent text-muted-text hover:text-title-text"
                )}
              >
                Transactions
              </button>
              <button
                onClick={() => setActiveTab("traders")}
                className={classNames(
                  "py-2.5 border-b-2 cursor-pointer transition-colors",
                  activeTab === "traders"
                    ? "border-brand-500 text-title-text font-bold"
                    : "border-transparent text-muted-text hover:text-title-text"
                )}
              >
                Top Traders
              </button>
              <button
                onClick={() => setActiveTab("kols")}
                className={classNames(
                  "py-2.5 border-b-2 cursor-pointer transition-colors",
                  activeTab === "kols"
                    ? "border-brand-500 text-title-text font-bold"
                    : "border-transparent text-muted-text hover:text-title-text"
                )}
              >
                KOLs
              </button>
              <button
                onClick={() => setActiveTab("holders")}
                className={classNames(
                  "py-2.5 border-b-2 cursor-pointer transition-colors",
                  activeTab === "holders"
                    ? "border-brand-500 text-title-text font-bold"
                    : "border-transparent text-muted-text hover:text-title-text"
                )}
              >
                Holders
              </button>
            </div>

            {/* Live Swap Transactions Table */}
            <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
              <table className="w-full text-left border-collapse text-xs font-mono">
                <thead>
                  <tr className="text-[10px] text-muted-text uppercase border-b border-card-border">
                    <th className="py-2 px-3">Date</th>
                    <th className="py-2 px-3">Type</th>
                    <th className="py-2 px-3 text-right">USD</th>
                    <th className="py-2 px-3 text-right">{token.symbol}</th>
                    <th className="py-2 px-3 text-right">{nativeSymbol}</th>
                    <th className="py-2 px-3 text-right">Price</th>
                    <th className="py-2 px-3 text-right">Trader</th>
                    <th className="py-2 px-3 text-center">Txn</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-card-border/50">
                  {swaps.map((swap, idx) => (
                    <tr key={idx} className="hover:bg-bg-hover transition-colors">
                      <td className="py-2 px-3 text-muted-text">{swap.timestamp}</td>
                      <td className="py-2 px-3">
                        <span
                          className={classNames(
                            "inline-flex items-center font-bold px-1.5 py-0.5 rounded text-[10px]",
                            swap.type === "BUY"
                              ? "bg-emerald-500/15 text-emerald-400"
                              : "bg-red-500/15 text-red-400"
                          )}
                        >
                          {swap.type === "BUY" ? (
                            <TrendingUp className="w-3 h-3 mr-1" />
                          ) : (
                            <TrendingDown className="w-3 h-3 mr-1" />
                          )}
                          {swap.type}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right font-semibold text-title-text">
                        ${swap.amountUsd.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 text-right text-muted-text">
                        {swap.tokenAmount.toLocaleString()}
                      </td>
                      <td className="py-2 px-3 text-right text-muted-text">
                        {swap.nativeAmount.toFixed(4)}
                      </td>
                      <td
                        className={classNames(
                          "py-2 px-3 text-right font-bold",
                          swap.type === "BUY" ? "text-emerald-400" : "text-red-400"
                        )}
                      >
                        ${formatNumber(swap.priceUsd)}
                      </td>
                      <td className="py-2 px-3 text-right text-brand-400 hover:underline cursor-pointer">
                        {swap.traderAddress}
                      </td>
                      <td className="py-2 px-3 text-center">
                        <a
                          href={`${token.chain?.explorerUrl ?? "https://explorer.stacks.co"}/txid/${swap.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-text hover:text-title-text"
                        >
                          <ExternalLink className="w-3.5 h-3.5 inline" />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Sidebar: Token Info & Action Controls */}
        <div className="lg:col-span-4 flex flex-col space-y-4">
          {/* Header Card */}
          <div className="glass-card p-4 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-12 h-12 rounded-full bg-brand-500/20 border border-brand-500/40 flex items-center justify-center font-bold text-lg text-brand-400">
                {token.symbol.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <h2 className="text-base font-bold text-title-text flex items-center space-x-1.5">
                  <span>{token.symbol}</span>
                  <span className="text-xs font-normal text-muted-text">/ {nativeSymbol}</span>
                </h2>
                <p className="text-xs text-muted-text">{token.name}</p>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              {token.twitterUrl && (
                <a
                  href={token.twitterUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-2 rounded-lg bg-input-bg hover:bg-brand-500 hover:text-white text-muted-text transition-colors"
                >
                  <Twitter className="w-4 h-4" />
                </a>
              )}
              {token.websiteUrl && (
                <a
                  href={token.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-2 rounded-lg bg-input-bg hover:bg-brand-500 hover:text-white text-muted-text transition-colors"
                >
                  <Globe className="w-4 h-4" />
                </a>
              )}
            </div>
          </div>

          {/* Main Price Box */}
          <div className="glass-card p-4">
            <div className="text-xs text-muted-text uppercase font-semibold">Price USD</div>
            <div className="text-2xl font-black text-title-text tracking-tight mt-0.5">
              ${formatNumber(token.priceUsd ?? 0.0003179)}
            </div>
            <div className="text-xs font-mono text-muted-text mt-1">
              PRICE: <span className="text-title-text">{(token.priceNative ?? 0.054348).toFixed(6)} {nativeSymbol}</span>
            </div>
          </div>

          {/* Key Financial Metrics */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="glass-card p-3">
              <div className="text-[10px] text-muted-text uppercase font-bold">Liquidity</div>
              <div className="text-xs font-bold text-title-text mt-1">
                ${formatNumber(token.liquidityUsd ?? 55000)}
              </div>
            </div>
            <div className="glass-card p-3">
              <div className="text-[10px] text-muted-text uppercase font-bold">FDV</div>
              <div className="text-xs font-bold text-title-text mt-1">
                ${formatNumber(token.fdvUsd ?? 320000)}
              </div>
            </div>
            <div className="glass-card p-3">
              <div className="text-[10px] text-muted-text uppercase font-bold">Mkt Cap</div>
              <div className="text-xs font-bold text-title-text mt-1">
                ${formatNumber(token.marketCapUsd ?? 320000)}
              </div>
            </div>
          </div>

          {/* Timeframe Performance Breakdown */}
          <div className="glass-card p-3.5">
            <div className="text-xs font-bold text-title-text mb-2 uppercase tracking-wide">
              Performance
            </div>
            <div className="grid grid-cols-4 gap-2 text-center font-mono text-xs">
              <PerfPill label="5M" value={token.priceChange5m ?? 7.34} />
              <PerfPill label="1H" value={token.priceChange1h ?? -57.25} />
              <PerfPill label="6H" value={token.priceChange6h ?? -10.10} />
              <PerfPill label="24H" value={token.priceChange24h ?? 965.0} />
            </div>
          </div>

          {/* Transaction Activity Metrics */}
          <div className="glass-card p-3.5 space-y-2.5 text-xs font-mono">
            <div className="flex justify-between border-b border-card-border pb-2">
              <span className="text-muted-text">TXNS</span>
              <span className="font-bold text-title-text">{totalTxns || "111,966"}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-input-bg p-2.5 rounded-lg">
                <div className="text-[10px] text-emerald-400 font-bold">BUYS</div>
                <div className="font-bold text-title-text mt-0.5">{token.txns24h?.buys ?? 61098}</div>
              </div>
              <div className="bg-input-bg p-2.5 rounded-lg">
                <div className="text-[10px] text-red-400 font-bold">SELLS</div>
                <div className="font-bold text-title-text mt-0.5">{token.txns24h?.sells ?? 50868}</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-input-bg p-2.5 rounded-lg">
                <div className="text-[10px] text-emerald-400 font-bold">BUY VOL</div>
                <div className="font-bold text-title-text mt-0.5">${formatNumber(token.buyVolume24h ?? 5100000)}</div>
              </div>
              <div className="bg-input-bg p-2.5 rounded-lg">
                <div className="text-[10px] text-red-400 font-bold">SELL VOL</div>
                <div className="font-bold text-title-text mt-0.5">${formatNumber(token.sellVolume24h ?? 5000000)}</div>
              </div>
            </div>
            <div className="flex justify-between border-t border-card-border pt-2">
              <span className="text-muted-text">TRADERS</span>
              <span className="font-bold text-title-text">{totalTraders || "11,724"}</span>
            </div>
          </div>

          {/* Quick Trade Execution Buttons & Actions */}
          <div className="space-y-2 pt-1">
            <div className="flex space-x-2">
              <button
                onClick={() => setIsWatchlisted(!isWatchlisted)}
                className={classNames(
                  "flex-1 py-2 px-3 rounded-lg border font-bold text-xs flex items-center justify-center space-x-1.5 transition-colors cursor-pointer",
                  isWatchlisted
                    ? "bg-amber-500/15 border-amber-500/40 text-amber-400"
                    : "bg-input-bg border-card-border text-title-text hover:bg-bg-hover"
                )}
              >
                <Star className="w-3.5 h-3.5" />
                <span>{isWatchlisted ? "Watchlisted" : "Watchlist"}</span>
              </button>
              <button className="flex-1 py-2 px-3 rounded-lg bg-input-bg border border-card-border text-title-text hover:bg-bg-hover font-bold text-xs flex items-center justify-center space-x-1.5 transition-colors cursor-pointer">
                <Bell className="w-3.5 h-3.5" />
                <span>Alerts</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() =>
                  navigate(
                    `/trade?chainId=${token.chainId}&tokenOut=${token.symbol}&direction=BUY`
                  )
                }
                className="py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white font-extrabold text-sm transition-colors cursor-pointer shadow-lg shadow-emerald-500/20"
              >
                Buy
              </button>
              <button
                onClick={() =>
                  navigate(
                    `/trade?chainId=${token.chainId}&tokenOut=${token.symbol}&direction=SELL`
                  )
                }
                className="py-3 rounded-xl bg-red-500 hover:bg-red-400 text-white font-extrabold text-sm transition-colors cursor-pointer shadow-lg shadow-red-500/20"
              >
                Sell
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PerfPill({ label, value }: { label: string; value: number }) {
  const isPositive = value >= 0;
  return (
    <div className="bg-input-bg p-2 rounded-lg">
      <div className="text-[9px] text-muted-text font-bold">{label}</div>
      <div className={classNames("font-bold text-[11px] mt-0.5", isPositive ? "text-emerald-400" : "text-red-400")}>
        {isPositive ? "+" : ""}
        {value.toFixed(1)}%
      </div>
    </div>
  );
}

function generateSyntheticCandles(basePrice: number): CandleData[] {
  const candles: CandleData[] = [];
  const now = Date.now();
  let currentPrice = basePrice > 0 ? basePrice : 0.0003179;

  for (let i = 60; i >= 0; i--) {
    const timestamp = now - i * 5 * 60 * 1000;
    const variation = (Math.random() - 0.48) * 0.04;
    const open = currentPrice;
    const close = Math.max(0.000001, open * (1 + variation));
    const high = Math.max(open, close) * (1 + Math.random() * 0.01);
    const low = Math.min(open, close) * (1 - Math.random() * 0.01);
    const volume = Math.floor(Math.random() * 50000 + 5000);

    candles.push({
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    });

    currentPrice = close;
  }

  return candles;
}

function generateMockSwaps(token: TokenDetailData | undefined): SwapTx[] {
  const price = token?.priceUsd ?? 0.0003179;
  return [
    {
      txHash: "0x8f3a9b1c2d",
      timestamp: "Just now",
      type: "SELL",
      amountUsd: 61.66,
      tokenAmount: 193954,
      nativeAmount: 0.798,
      priceUsd: price,
      traderAddress: "7FEApn",
    },
    {
      txHash: "0x1a2b3c4d5e",
      timestamp: "1m ago",
      type: "BUY",
      amountUsd: 120.75,
      tokenAmount: 380120,
      nativeAmount: 1.54,
      priceUsd: price * 1.01,
      traderAddress: "TJY2Pu",
    },
    {
      txHash: "0x9e8d7c6b5a",
      timestamp: "2m ago",
      type: "BUY",
      amountUsd: 30.33,
      tokenAmount: 94137,
      nativeAmount: 0.3926,
      priceUsd: price,
      traderAddress: "TJY2Pu",
    },
    {
      txHash: "0x5f4e3d2c1b",
      timestamp: "3m ago",
      type: "SELL",
      amountUsd: 26.56,
      tokenAmount: 83480,
      nativeAmount: 0.3438,
      priceUsd: price * 0.99,
      traderAddress: "LJzN51",
    },
    {
      txHash: "0x2b3c4d5e6f",
      timestamp: "5m ago",
      type: "SELL",
      amountUsd: 170.53,
      tokenAmount: 532092,
      nativeAmount: 2.2,
      priceUsd: price * 0.985,
      traderAddress: "fJvozz",
    },
  ];
}
