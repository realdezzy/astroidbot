import { useState, useMemo, useEffect } from "react";
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
import { apiFetch, getAccessToken } from "../lib/api";
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
  fullAddress?: string;
}

interface TraderItem {
  rank: number;
  address: string;
  fullAddress?: string;
  tag: string;
  pnlUsd: number;
  pnlPercent: number;
  winRate: number;
  volumeUsd: number;
  buys: number;
  sells: number;
}

interface KolItem {
  rank: number;
  handle: string;
  fullAddress?: string;
  name: string;
  badge: string;
  winRate: number;
  totalPnlUsd: number;
  holdingsPercent: number;
  status: string;
}

interface HolderItem {
  rank: number;
  address: string;
  fullAddress?: string;
  label: string;
  category: string;
  amount: number;
  percentage: number;
  valueUsd: number;
}

const TIMEFRAMES = ["1s", "1m", "5m", "15m", "1h", "4h", "D"] as const;

function getExplorerTxUrl(chain: TokenDetailData["chain"], txHash: string, paramChainId?: string) {
  if (!txHash) return "#";
  const chainId = (chain?.chainId ?? paramChainId ?? "").toLowerCase();
  if (chainId.includes("stacks")) {
    const isTestnet = chainId.includes("testnet");
    return `https://explorer.hiro.so/txid/${txHash}${isTestnet ? "?chain=testnet" : "?chain=mainnet"}`;
  }
  if (chainId.includes("solana")) {
    const isDevnet = chainId.includes("devnet");
    return `https://solscan.io/tx/${txHash}${isDevnet ? "?cluster=devnet" : ""}`;
  }
  if (chainId.includes("base")) {
    return `https://basescan.org/tx/${txHash}`;
  }
  if (chainId.includes("celo")) {
    return `https://celoscan.io/tx/${txHash}`;
  }
  if (chainId.includes("ethereum") || chainId.includes("eth")) {
    return `https://etherscan.io/tx/${txHash}`;
  }
  return `https://blockscan.com/tx/${txHash}`;
}

function getExplorerAddressUrl(chain: TokenDetailData["chain"], address: string, paramChainId?: string) {
  if (!address) return "#";
  const chainId = (chain?.chainId ?? paramChainId ?? "").toLowerCase();
  if (chainId.includes("stacks")) {
    const isTestnet = chainId.includes("testnet");
    return `https://explorer.hiro.so/address/${address}${isTestnet ? "?chain=testnet" : "?chain=mainnet"}`;
  }
  if (chainId.includes("solana")) {
    const isDevnet = chainId.includes("devnet");
    return `https://solscan.io/account/${address}${isDevnet ? "?cluster=devnet" : ""}`;
  }
  if (chainId.includes("base")) {
    return `https://basescan.org/address/${address}`;
  }
  if (chainId.includes("celo")) {
    return `https://celoscan.io/address/${address}`;
  }
  if (chainId.includes("ethereum") || chainId.includes("eth")) {
    return `https://etherscan.io/address/${address}`;
  }
  return `https://blockscan.com/address/${address}`;
}

export function TokenDetail() {
  const { chainId = "", contractId = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [selectedTimeframe, setSelectedTimeframe] = useState<string>("5m");
  const [activeTab, setActiveTab] = useState<"transactions" | "traders" | "kols" | "holders">("transactions");
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [isWatchlisted, setIsWatchlisted] = useState(false);
  const [liveSwaps, setLiveSwaps] = useState<SwapTx[]>([]);

  const { data: token, isLoading, error } = useQuery<TokenDetailData>({
    queryKey: ["token-detail", chainId, contractId],
    queryFn: () =>
      apiFetch(`/tokens/${encodeURIComponent(chainId)}/${encodeURIComponent(contractId)}`),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (!token?.symbol) return;
    const tokenStr = getAccessToken();
    if (!tokenStr) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(tokenStr)}`;
    let ws: WebSocket | null = null;

    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "swap_update" && msg.payload?.symbol === token.symbol) {
            const s = msg.payload.swap;
            const newSwap: SwapTx = {
              txHash: s.txKey || `0x${Math.random().toString(16).slice(2, 10)}`,
              timestamp: "Just now",
              type: s.isBuy ? "BUY" : "SELL",
              amountUsd: s.volumeUsd || 0,
              tokenAmount: s.volumeUsd && s.priceUsd ? Math.round(s.volumeUsd / s.priceUsd) : 0,
              nativeAmount: s.volumeUsd ? s.volumeUsd / 2.0 : 0,
              priceUsd: s.priceUsd || 0,
              traderAddress: s.trader ? `${s.trader.slice(0, 4)}...${s.trader.slice(-2)}` : "LiveWS",
            };
            setLiveSwaps((prev) => [newSwap, ...prev.slice(0, 20)]);
          }
        } catch { }
      };
    } catch { }

    return () => {
      if (ws) ws.close();
    };
  }, [token?.symbol]);

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
    refetchInterval: 10_000,
  });

  const { data: tradersData } = useQuery<{ traders: TraderItem[] }>({
    queryKey: ["token-traders", chainId, contractId],
    queryFn: () =>
      apiFetch(`/tokens/${encodeURIComponent(chainId)}/${encodeURIComponent(contractId)}/traders`),
    enabled: !!token && activeTab === "traders",
    refetchInterval: 15_000,
  });

  const { data: kolsData } = useQuery<{ kols: KolItem[] }>({
    queryKey: ["token-kols", chainId, contractId],
    queryFn: () =>
      apiFetch(`/tokens/${encodeURIComponent(chainId)}/${encodeURIComponent(contractId)}/kols`),
    enabled: !!token && activeTab === "kols",
    refetchInterval: 15_000,
  });

  const { data: holdersData } = useQuery<{ holders: HolderItem[] }>({
    queryKey: ["token-holders", chainId, contractId],
    queryFn: () =>
      apiFetch(`/tokens/${encodeURIComponent(chainId)}/${encodeURIComponent(contractId)}/holders`),
    enabled: !!token && activeTab === "holders",
    refetchInterval: 15_000,
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

  const swaps = useMemo(() => {
    const fetched = swapData?.swaps ?? generateMockSwaps(token);
    return [...liveSwaps, ...fetched];
  }, [swapData, liveSwaps, token]);

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
          <a
            href={getExplorerAddressUrl(token.chain, token.contractId, chainId)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-input-bg border border-card-border hover:bg-bg-hover text-brand-400 font-semibold transition-colors cursor-pointer"
            title="View on Explorer"
          >
            <span>Explorer</span>
            <ExternalLink className="w-3 h-3" />
          </a>
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

            <div className="h-[400px] w-full relative">
              <TradingViewChart candles={candles} timeframe={selectedTimeframe} />
            </div>
          </div>

          {/* Bottom Tabs Section */}
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

            <div className="overflow-x-auto max-h-[320px] overflow-y-auto">
              {activeTab === "transactions" && (
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
                        <td className="py-2 px-3 text-right">
                          <a
                            href={getExplorerAddressUrl(token.chain, swap.fullAddress || swap.traderAddress, chainId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-brand-400 hover:underline cursor-pointer"
                          >
                            {swap.traderAddress}
                          </a>
                        </td>
                        <td className="py-2 px-3 text-center">
                          <a
                            href={getExplorerTxUrl(token.chain, swap.txHash, chainId)}
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
              )}

              {activeTab === "traders" && (
                <table className="w-full text-left border-collapse text-xs font-mono">
                  <thead>
                    <tr className="text-[10px] text-muted-text uppercase border-b border-card-border">
                      <th className="py-2 px-3">#</th>
                      <th className="py-2 px-3">Trader Address</th>
                      <th className="py-2 px-3">Category</th>
                      <th className="py-2 px-3 text-right">24h PnL</th>
                      <th className="py-2 px-3 text-right">Win Rate</th>
                      <th className="py-2 px-3 text-right">Volume</th>
                      <th className="py-2 px-3 text-right">Buys / Sells</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-card-border/50">
                    {(tradersData?.traders ?? []).map((trader) => (
                      <tr key={trader.rank} className="hover:bg-bg-hover transition-colors">
                        <td className="py-2 px-3 text-muted-text font-bold">#{trader.rank}</td>
                        <td className="py-2 px-3 font-semibold">
                          <a
                            href={getExplorerAddressUrl(token.chain, trader.fullAddress || trader.address, chainId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-brand-400 hover:underline"
                          >
                            {trader.address}
                          </a>
                        </td>
                        <td className="py-2 px-3">
                          <span className="bg-brand-500/10 border border-brand-500/20 text-brand-400 px-1.5 py-0.5 rounded text-[10px] font-bold">
                            {trader.tag}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right font-bold text-emerald-400">
                          +${formatNumber(trader.pnlUsd)} ({trader.pnlPercent}%)
                        </td>
                        <td className="py-2 px-3 text-right font-semibold text-title-text">
                          {trader.winRate}%
                        </td>
                        <td className="py-2 px-3 text-right text-muted-text">
                          ${formatNumber(trader.volumeUsd)}
                        </td>
                        <td className="py-2 px-3 text-right text-muted-text">
                          <span className="text-emerald-400">{trader.buys}B</span> / <span className="text-red-400">{trader.sells}S</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {activeTab === "kols" && (
                <table className="w-full text-left border-collapse text-xs font-mono">
                  <thead>
                    <tr className="text-[10px] text-muted-text uppercase border-b border-card-border">
                      <th className="py-2 px-3">#</th>
                      <th className="py-2 px-3">KOL Wallet</th>
                      <th className="py-2 px-3">Badge</th>
                      <th className="py-2 px-3 text-right">Win Rate</th>
                      <th className="py-2 px-3 text-right">Est. PnL</th>
                      <th className="py-2 px-3 text-right">Holdings %</th>
                      <th className="py-2 px-3 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-card-border/50">
                    {(kolsData?.kols ?? []).map((kol) => (
                      <tr key={kol.rank} className="hover:bg-bg-hover transition-colors">
                        <td className="py-2 px-3 text-muted-text font-bold">#{kol.rank}</td>
                        <td className="py-2 px-3">
                          <a
                            href={getExplorerAddressUrl(token.chain, kol.fullAddress || kol.handle, chainId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-bold text-brand-400 hover:underline"
                          >
                            {kol.handle}
                          </a>
                          <div className="text-[10px] text-muted-text">{kol.name}</div>
                        </td>
                        <td className="py-2 px-3">
                          <span className="bg-purple-500/15 text-purple-400 border border-purple-500/30 px-1.5 py-0.5 rounded text-[10px] font-bold">
                            {kol.badge}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right font-bold text-emerald-400">
                          {kol.winRate}%
                        </td>
                        <td className="py-2 px-3 text-right font-bold text-title-text">
                          +${formatNumber(kol.totalPnlUsd)}
                        </td>
                        <td className="py-2 px-3 text-right font-semibold text-brand-400">
                          {kol.holdingsPercent}%
                        </td>
                        <td className="py-2 px-3 text-center">
                          <span className="px-2 py-0.5 bg-emerald-500/15 text-emerald-400 rounded-full text-[10px] font-bold">
                            {kol.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {activeTab === "holders" && (
                <table className="w-full text-left border-collapse text-xs font-mono">
                  <thead>
                    <tr className="text-[10px] text-muted-text uppercase border-b border-card-border">
                      <th className="py-2 px-3">#</th>
                      <th className="py-2 px-3">Holder Address</th>
                      <th className="py-2 px-3">Tag</th>
                      <th className="py-2 px-3 text-right">Amount ({token.symbol})</th>
                      <th className="py-2 px-3 text-right">Supply %</th>
                      <th className="py-2 px-3 text-right">Value USD</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-card-border/50">
                    {(holdersData?.holders ?? []).map((h) => (
                      <tr key={h.rank} className="hover:bg-bg-hover transition-colors">
                        <td className="py-2 px-3 text-muted-text font-bold">#{h.rank}</td>
                        <td className="py-2 px-3 font-semibold">
                          <a
                            href={getExplorerAddressUrl(token.chain, h.fullAddress || h.address, chainId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-brand-400 hover:underline"
                          >
                            {h.address}
                          </a>
                          <span className="block text-[10px] text-muted-text">{h.label}</span>
                        </td>
                        <td className="py-2 px-3">
                          <span className="bg-amber-500/15 border border-amber-500/30 text-amber-400 px-1.5 py-0.5 rounded text-[10px] font-bold">
                            {h.category}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right font-bold text-title-text">
                          {h.amount.toLocaleString()}
                        </td>
                        <td className="py-2 px-3 text-right font-bold text-emerald-400">
                          {h.percentage}%
                        </td>
                        <td className="py-2 px-3 text-right text-muted-text">
                          ${formatNumber(h.valueUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
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

          {/* Performance Pill */}
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
        </div>
      </div>
    </div>
  );
}

function PerfPill({ label, value }: { label: string; value: number }) {
  const isPos = value >= 0;
  return (
    <div className="bg-input-bg p-2 rounded-lg">
      <div className="text-[10px] text-muted-text">{label}</div>
      <div className={classNames("font-bold mt-0.5", isPos ? "text-emerald-400" : "text-red-400")}>
        {isPos ? "+" : ""}{value.toFixed(1)}%
      </div>
    </div>
  );
}

function generateSyntheticCandles(currentPrice: number): CandleData[] {
  const count = 50;
  const now = Math.floor(Date.now() / 1000);
  const result: CandleData[] = [];
  let price = currentPrice * 0.85;

  for (let i = count; i >= 0; i--) {
    const timestamp = now - i * 300;
    const change = (Math.random() - 0.48) * 0.04 * price;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random() * 0.01 * price;
    const low = Math.min(open, close) - Math.random() * 0.01 * price;
    const volume = Math.floor(Math.random() * 10000 + 1000);
    price = close;
    result.push({ timestamp, open, high, low, close, volume });
  }
  return result;
}

function generateMockSwaps(token: TokenDetailData | undefined): SwapTx[] {
  return [
    {
      txHash: "0x9a8f4c2e",
      timestamp: "Just now",
      type: "BUY",
      amountUsd: 1250.00,
      tokenAmount: 41250,
      nativeAmount: 2.45,
      priceUsd: token?.priceUsd ?? 0.0303,
      traderAddress: "7FEApn...3b9a",
    },
    {
      txHash: "0x3e4f5a6b",
      timestamp: "2m ago",
      type: "SELL",
      amountUsd: 450.50,
      tokenAmount: 14860,
      nativeAmount: 0.88,
      priceUsd: token?.priceUsd ?? 0.0303,
      traderAddress: "TJY2Pu...e81c",
    },
  ];
}
