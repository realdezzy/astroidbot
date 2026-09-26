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
import { classNames, formatDate, formatNumber } from "../lib/utils";
import { ChainDexBadge } from "../components/ChainDexBadge";
import { TradingViewChart, CandleData } from "../components/TradingViewChart";
import { useAppRoutes } from "../lib/appRoutes";
import { useTelegram } from "../lib/telegram/TelegramProvider";

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

/**
 * A row as `/tokens/:chainId/:contractId/swaps` actually answers it.
 *
 * `tokenAmount` and `nativeAmount` are optional because nothing sends them —
 * they were declared required and the only rows that ever carried them were
 * the mock swaps this file used to invent. `txHash` is the display-shortened
 * form (`0x1234...abcd`) and resolves nowhere; `fullTxHash` is the hash.
 */
interface SwapTx {
  txHash: string;
  fullTxHash?: string;
  /** ISO timestamp of the swap's bucket, not of when we indexed it. */
  timestamp: string;
  type: "BUY" | "SELL";
  amountUsd: number;
  tokenAmount?: number | null;
  nativeAmount?: number | null;
  priceUsd: number;
  traderAddress: string;
  fullAddress?: string;
}

/**
 * `/traders` is a volume leaderboard aggregated from indexed swaps and nothing
 * else. PnL, win rate and buy/sell counts were rendered here against a shape
 * the route has never returned, so every row read `+$NaN (undefined%)` — a
 * number that looked like a measurement.
 */
interface TraderItem {
  rank: number;
  address: string;
  fullAddress?: string;
  tag: string;
  volumeUsd: number;
  trades: number;
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

/**
 * An explorer link for `address` on this token's chain, or null when we cannot
 * build one honestly.
 *
 * The API resolves exactly one explorer URL for us — the chain descriptor's
 * address URL for the contract being viewed — so the link for any *other*
 * address on the same chain is that URL with the address swapped in. Doing it
 * this way keeps every explorer hostname and path shape on the server, where
 * the descriptor already holds them.
 *
 * What was here before was a six-branch substring ladder over the ChainId that
 * fell through to blockscan.com for anything it had not been taught, so every
 * Robinhood Chain link on this page was a 404 — the same class of bug that put
 * a Hiro URL on Base trades in four other components.
 */
function explorerAddressUrl(
  chain: TokenDetailData["chain"],
  contractId: string,
  address: string
): string | null {
  if (!chain?.explorerUrl || !address) return null;
  if (address === contractId) return chain.explorerUrl;
  if (!chain.explorerUrl.includes(contractId)) return null;
  return chain.explorerUrl.replace(contractId, encodeURIComponent(address));
}

export function TokenDetail() {
  const { chainId = "", contractId = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const routes = useAppRoutes();
  const { webApp } = useTelegram();

  const [selectedTimeframe, setSelectedTimeframe] = useState<string>("5m");
  const [activeTab, setActiveTab] = useState<"transactions" | "traders" | "kols" | "holders">("transactions");
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [isWatchlisted, setIsWatchlisted] = useState(false);
  const [liveSwaps, setLiveSwaps] = useState<SwapTx[]>([]);
  const [openingChat, setOpeningChat] = useState(false);

  const continueInChat = async () => {
    if (!token || openingChat) return;
    setOpeningChat(true);
    try {
      const link = await apiFetch<{ url: string }>("/me/deep-links", {
        method: "POST",
        body: JSON.stringify({ kind: "token", chainId: token.chainId, contractId: token.contractId }),
      });
      webApp?.HapticFeedback?.impactOccurred("light");
      if (webApp?.openTelegramLink) webApp.openTelegramLink(link.url);
      else window.location.assign(link.url);
    } finally {
      setOpeningChat(false);
    }
  };

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
            // Only what the event carries. A random hex string stood in for a
            // missing tx hash and `volumeUsd / 2` stood in for the native leg —
            // two values that render exactly like measured ones.
            const fullTxHash = typeof s.txKey === "string" ? s.txKey.split(":")[0] : undefined;
            const newSwap: SwapTx = {
              txHash: fullTxHash
                ? `${fullTxHash.slice(0, 6)}...${fullTxHash.slice(-4)}`
                : "—",
              fullTxHash,
              timestamp: new Date().toISOString(),
              type: s.isBuy ? "BUY" : "SELL",
              amountUsd: s.volumeUsd || 0,
              tokenAmount: s.volumeUsd && s.priceUsd ? s.volumeUsd / s.priceUsd : null,
              nativeAmount: null,
              priceUsd: s.priceUsd || 0,
              traderAddress: s.trader ? `${s.trader.slice(0, 6)}...${s.trader.slice(-4)}` : "Unknown",
              fullAddress: typeof s.trader === "string" ? s.trader : undefined,
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

  const { data: swapData } = useQuery<{ swaps: SwapTx[]; message?: string }>({
    queryKey: ["token-swaps", chainId, contractId],
    queryFn: () =>
      apiFetch(`/tokens/${encodeURIComponent(chainId)}/${encodeURIComponent(contractId)}/swaps`),
    enabled: !!token,
    refetchInterval: 10_000,
  });

  const { data: tradersData } = useQuery<{ traders: TraderItem[]; message?: string }>({
    queryKey: ["token-traders", chainId, contractId],
    queryFn: () =>
      apiFetch(`/tokens/${encodeURIComponent(chainId)}/${encodeURIComponent(contractId)}/traders`),
    enabled: !!token && activeTab === "traders",
    refetchInterval: 15_000,
  });

  const { data: kolsData } = useQuery<{ kols: KolItem[]; message?: string }>({
    queryKey: ["token-kols", chainId, contractId],
    queryFn: () =>
      apiFetch(`/tokens/${encodeURIComponent(chainId)}/${encodeURIComponent(contractId)}/kols`),
    enabled: !!token && activeTab === "kols",
    refetchInterval: 15_000,
  });

  const { data: holdersData } = useQuery<{ holders: HolderItem[]; message?: string }>({
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

  // Whatever the API returned, and nothing else.
  //
  // Both of these used to fall back to generated data — a `Math.random()`
  // random walk for the chart and two invented trades for the table — so a
  // token nobody has traded rendered as a token with a price history. The
  // backend deleted exactly this fabrication from `candleService` and wrote
  // down why: an empty chart is a true statement about such a token, and an
  // invented one is not. This layer put it back.
  const candles = candleData?.candles ?? [];
  const swaps = useMemo(() => [...liveSwaps, ...(swapData?.swaps ?? [])], [swapData, liveSwaps]);

  // The last candle is the only honest source for the OHLC header. High and
  // Low were `price * 1.02` and `price * 0.98`, which is a fixed 4% band drawn
  // in green and red as though it were the session's range.
  const latestCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;

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
        <Link to={routes.tokenList} className="mt-4 inline-block text-brand-400 font-semibold hover:underline">
          Back to Token Discovery
        </Link>
      </div>
    );
  }

  // Both of these defaulted to a specific answer — "SOL" and "DexScreener" —
  // for the case where we do not have one, which reads as a fact about the
  // token rather than as a gap. An unlabelled pair is the honest render.
  const nativeSymbol = token.chain?.nativeSymbol ?? "";
  const dexName = token.dexId ?? null;
  const totalTxns = (token.txns24h?.buys ?? 0) + (token.txns24h?.sells ?? 0);

  return (
    <div className="space-y-4">
      {/* Navigation Header */}
      <div className="glass-card px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <Link
            to={routes.tokenList}
            className="inline-flex items-center text-xs text-muted-text hover:text-title-text transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-1" /> Tokens
          </Link>
          <span className="text-muted-text/50">/</span>
          <div className="flex items-center space-x-2">
            <ChainDexBadge chainId={token.chainId} dexId={dexName ?? undefined} />
            <h1 className="text-sm font-bold text-title-text">
              {nativeSymbol ? `${token.symbol}/${nativeSymbol}` : token.symbol}
            </h1>
            {dexName && (
              <span className="text-xs text-muted-text font-mono">on {dexName}</span>
            )}
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
          {token.chain?.explorerUrl && (
            <a
              href={token.chain.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-input-bg border border-card-border hover:bg-bg-hover text-brand-400 font-semibold transition-colors cursor-pointer"
              title="View on Explorer"
            >
              <span>Explorer</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
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
                  O <span className="text-title-text">{ohlc(latestCandle?.open)}</span>
                </span>
                <span className="text-muted-text">
                  H <span className="text-emerald-400">{ohlc(latestCandle?.high)}</span>
                </span>
                <span className="text-muted-text">
                  L <span className="text-red-400">{ohlc(latestCandle?.low)}</span>
                </span>
                <span className="text-muted-text">
                  Vol <span className="text-brand-400">{ohlc(token.volume24h)}</span>
                </span>
              </div>
            </div>

            <div className="h-[400px] w-full relative">
              {candles.length > 0 ? (
                <TradingViewChart candles={candles} timeframe={selectedTimeframe} />
              ) : (
                <div className="h-full flex flex-col items-center justify-center space-y-1 text-center">
                  <span className="text-sm font-semibold text-muted-text">
                    No price history for this token yet
                  </span>
                  <span className="text-xs text-muted-text/70">
                    Nothing has been indexed on {token.chain?.displayName ?? token.chainId} at the{" "}
                    {selectedTimeframe} interval.
                  </span>
                </div>
              )}
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
                      <th className="py-2 px-3 text-right">{nativeSymbol || "Native"}</th>
                      <th className="py-2 px-3 text-right">Price</th>
                      <th className="py-2 px-3 text-right">Trader</th>
                      <th className="py-2 px-3 text-center">Txn</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-card-border/50">
                    {swaps.map((swap, idx) => (
                      <tr key={idx} className="hover:bg-bg-hover transition-colors">
                        <td className="py-2 px-3 text-muted-text">{formatDate(swap.timestamp)}</td>
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
                          {swap.amountUsd != null ? `$${swap.amountUsd.toFixed(2)}` : "—"}
                        </td>
                        <td className="py-2 px-3 text-right text-muted-text">
                          {swap.tokenAmount != null
                            ? formatNumber(swap.tokenAmount, 4)
                            : swap.amountUsd && swap.priceUsd
                            ? formatNumber(swap.amountUsd / swap.priceUsd, 4)
                            : "—"}
                        </td>
                        <td className="py-2 px-3 text-right text-muted-text">
                          {swap.nativeAmount != null
                            ? swap.nativeAmount.toFixed(4)
                            : "—"}
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
                          <ExplorerAddress
                            chain={token.chain}
                            contractId={contractId}
                            address={swap.fullAddress}
                            label={swap.traderAddress}
                            className="text-brand-400"
                          />
                        </td>
                        {/* A copy, not a link. The link here was built from
                          * `txHash`, which is the shortened display form the
                          * API produces for the table — "0xabc123...def4" is
                          * not a hash any explorer can look up. `fullTxHash`
                          * is, and the API does not resolve a per-swap
                          * explorer URL for us the way the trade routes do. */}
                        <td className="py-2 px-3 text-center">
                          {swap.fullTxHash ? (
                            <button
                              onClick={() => copyToClipboard(swap.fullTxHash!, `tx:${swap.fullTxHash}`)}
                              title={`Copy ${swap.fullTxHash}`}
                              className="text-muted-text hover:text-title-text cursor-pointer"
                            >
                              {copiedField === `tx:${swap.fullTxHash}` ? (
                                <Check className="w-3.5 h-3.5 inline text-emerald-400" />
                              ) : (
                                <Copy className="w-3.5 h-3.5 inline" />
                              )}
                            </button>
                          ) : (
                            <span className="text-muted-text/50">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {swaps.length === 0 && (
                      <TabEmpty
                        colSpan={8}
                        message={swapData?.message ?? "No indexed swaps for this token yet."}
                      />
                    )}
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
                      <th className="py-2 px-3 text-right">Volume</th>
                      <th className="py-2 px-3 text-right">Swaps</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-card-border/50">
                    {(tradersData?.traders ?? []).map((trader) => (
                      <tr key={trader.rank} className="hover:bg-bg-hover transition-colors">
                        <td className="py-2 px-3 text-muted-text font-bold">#{trader.rank}</td>
                        <td className="py-2 px-3 font-semibold">
                          <ExplorerAddress
                            chain={token.chain}
                            contractId={contractId}
                            address={trader.fullAddress}
                            label={trader.address}
                            className="text-brand-400"
                          />
                        </td>
                        <td className="py-2 px-3">
                          <span className="bg-brand-500/10 border border-brand-500/20 text-brand-400 px-1.5 py-0.5 rounded text-[10px] font-bold">
                            {trader.tag}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right font-semibold text-title-text">
                          ${formatNumber(trader.volumeUsd)}
                        </td>
                        <td className="py-2 px-3 text-right text-muted-text">
                          {trader.trades.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                    {(tradersData?.traders ?? []).length === 0 && (
                      <TabEmpty
                        colSpan={5}
                        message={tradersData?.message ?? "No indexed swaps to rank traders by yet."}
                      />
                    )}
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
                          <ExplorerAddress
                            chain={token.chain}
                            contractId={contractId}
                            address={kol.fullAddress}
                            label={kol.handle}
                            className="font-bold text-brand-400"
                          />
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
                    {(kolsData?.kols ?? []).length === 0 && (
                      <TabEmpty colSpan={7} message={kolsData?.message} />
                    )}
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
                          <ExplorerAddress
                            chain={token.chain}
                            contractId={contractId}
                            address={h.fullAddress}
                            label={h.address}
                            className="text-brand-400"
                          />
                          <span className="block text-[10px] text-muted-text">{h.label}</span>
                        </td>
                        <td className="py-2 px-3">
                          <span className="bg-amber-500/15 border border-amber-500/30 text-amber-400 px-1.5 py-0.5 rounded text-[10px] font-bold">
                            {h.category}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right font-bold text-title-text">
                          {h.amount != null ? h.amount.toLocaleString() : "—"}
                        </td>
                        <td className="py-2 px-3 text-right font-bold text-emerald-400">
                          {h.percentage}%
                        </td>
                        <td className="py-2 px-3 text-right text-muted-text">
                          ${formatNumber(h.valueUsd)}
                        </td>
                      </tr>
                    ))}
                    {(holdersData?.holders ?? []).length === 0 && (
                      <TabEmpty colSpan={6} message={holdersData?.message} />
                    )}
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
                  {nativeSymbol && (
                    <span className="text-xs font-normal text-muted-text">/ {nativeSymbol}</span>
                  )}
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
              {token.priceUsd != null ? `$${formatNumber(token.priceUsd)}` : "N/A"}
            </div>
            <div className="text-xs font-mono text-muted-text mt-1">
              PRICE: <span className="text-title-text">{token.priceNative != null && nativeSymbol ? `${token.priceNative.toFixed(6)} ${nativeSymbol}` : "—"}</span>
            </div>
          </div>

          {/* Key Financial Metrics */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="glass-card p-3">
              <div className="text-[10px] text-muted-text uppercase font-bold">Liquidity</div>
              <div className="text-xs font-bold text-title-text mt-1">
                {token.liquidityUsd != null ? `$${formatNumber(token.liquidityUsd)}` : "—"}
              </div>
            </div>
            <div className="glass-card p-3">
              <div className="text-[10px] text-muted-text uppercase font-bold">FDV</div>
              <div className="text-xs font-bold text-title-text mt-1">
                {token.fdvUsd != null ? `$${formatNumber(token.fdvUsd)}` : (token.marketCapUsd != null ? `$${formatNumber(token.marketCapUsd)}` : "—")}
              </div>
            </div>
            <div className="glass-card p-3">
              <div className="text-[10px] text-muted-text uppercase font-bold">Mkt Cap</div>
              <div className="text-xs font-bold text-title-text mt-1">
                {token.marketCapUsd != null ? `$${formatNumber(token.marketCapUsd)}` : "—"}
              </div>
            </div>
          </div>

          {/* Performance Pill */}
          <div className="glass-card p-3.5">
            <div className="text-xs font-bold text-title-text mb-2 uppercase tracking-wide">
              Performance
            </div>
            <div className="grid grid-cols-4 gap-2 text-center font-mono text-xs">
              <PerfPill label="5M" value={token.priceChange5m} />
              <PerfPill label="1H" value={token.priceChange1h} />
              <PerfPill label="6H" value={token.priceChange6h} />
              <PerfPill label="24H" value={token.priceChange24h} />
            </div>
          </div>

          {/* Action Card */}
          <div className="glass-card p-4 flex flex-col space-y-3 bg-brand-500/5 border border-brand-500/20 rounded-xl">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-title-text uppercase">Instant Route</span>
              <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded font-bold">
                {token.tradable ? "Swappable" : "Indexed Only"}
              </span>
            </div>
            <button
              onClick={() => routes.isTelegram
                ? void continueInChat()
                : navigate(`/trade?chainId=${encodeURIComponent(token.chainId)}&tokenOut=${encodeURIComponent(token.contractId)}`)
              }
              disabled={openingChat}
              className="w-full py-2.5 rounded-xl bg-brand-500 hover:bg-brand-600 text-white font-bold text-sm shadow-lg shadow-brand-500/25 transition-all flex items-center justify-center space-x-2 cursor-pointer"
            >
              <span>{routes.isTelegram ? (openingChat ? "Opening chat…" : `Continue ${token.symbol} in chat`) : `Trade ${token.symbol}`}</span>
              <ExternalLink className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One price-change cell.
 *
 * A missing change is not a flat one. The call sites coerced every null with
 * `?? 0`, so a token we have no 5-minute window for rendered a green +0.0% —
 * a claim that it traded and did not move.
 */
function PerfPill({ label, value }: { label: string; value?: number | null }) {
  if (value == null) {
    return (
      <div className="bg-input-bg p-2 rounded-lg">
        <div className="text-[10px] text-muted-text">{label}</div>
        <div className="font-bold mt-0.5 text-muted-text/60">—</div>
      </div>
    );
  }

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

/** A USD figure, or an em dash when we do not have one. */
function ohlc(value: number | null | undefined): string {
  return value != null ? `$${formatNumber(value)}` : "—";
}

/**
 * An address as an explorer link when `explorerAddressUrl` can build one for
 * this chain, and as plain text when it cannot. A guessed link is worse than
 * no link: it looks like a way to verify the row and goes to a 404.
 */
function ExplorerAddress({
  chain,
  contractId,
  address,
  label,
  className,
}: {
  chain: TokenDetailData["chain"];
  contractId: string;
  address?: string;
  label: string;
  className?: string;
}) {
  const href = address ? explorerAddressUrl(chain, contractId, address) : null;
  if (!href) return <span className={className}>{label}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={classNames(className, "hover:underline cursor-pointer")}
    >
      {label}
    </a>
  );
}

/**
 * The row a tab shows when it has nothing to show, carrying the API's own
 * explanation. The KOL and holder routes answer `[]` plus a `message` saying
 * why — "On-chain holder indexer pending for this network" — and the UI threw
 * the message away, leaving a table of headers over blank space.
 */
function TabEmpty({ colSpan, message }: { colSpan: number; message?: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="py-10 px-3 text-center text-muted-text text-[11px]">
        {message ?? "Nothing recorded for this token yet."}
      </td>
    </tr>
  );
}
