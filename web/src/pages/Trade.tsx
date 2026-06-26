import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownUp,
  Zap,
  Loader2,
  Info,
  Wallet,
  CheckSquare,
  Square,
  ArrowRightLeft,
  Receipt,
} from "lucide-react";
import { apiFetch } from "../lib/api";
import { formatNumber, classNames } from "../lib/utils";
import { TokenSelect } from "../components/TokenSelect";
import { TradeHistory } from "./ui/TradeHistory";
import { MultiWalletSelect } from "../components/MultiWalletSelect";

interface Token {
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
}
interface WalletItem {
  id: number;
  address: string;
  name: string;
  balance: number;
}
interface QuoteItem {
  dex: string;
  amountOut: number;
  priceImpact: number;
  feeBps: number;
  feeAmount: number;
  isBest: boolean;
}
interface QuoteResult {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  amountOut: number;
  priceImpact: number;
  feeBps: number;
  feeAmount: number;
  dex?: string;
  quotes?: QuoteItem[];
}

type TradeTab = "swap" | "history";

export function Trade() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TradeTab>("swap");
  const [selectedWalletIds, setSelectedWalletIds] = useState<number[]>([]);
  const [direction, setDirection] = useState<"BUY" | "SELL">("BUY");
  const [tokenIn, setTokenIn] = useState("STX");
  const [tokenOut, setTokenOut] = useState("sUSDT");
  const [amount, setAmount] = useState("");
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [selectedDex, setSelectedDex] = useState<string | null>(null);

  const { data: tokensData } = useQuery<{ tokens: Token[] }>({
    queryKey: ["tokens"],
    queryFn: () => apiFetch("/tokens"),
  });

  const { data: wallets } = useQuery<WalletItem[]>({
    queryKey: ["wallets"],
    queryFn: () => apiFetch("/me/wallets"),
  });

  const tokens = tokensData?.tokens ?? [];

  const { data: quote, isFetching: quoteLoading } = useQuery<QuoteResult>({
    queryKey: ["quote", tokenIn, tokenOut, amount],
    queryFn: () =>
      apiFetch(
        `/me/trades/quote?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amount}`
      ),
    enabled:
      !!tokenIn &&
      !!tokenOut &&
      !!amount &&
      parseFloat(amount) > 0 &&
      tokenIn !== tokenOut,
    refetchInterval: 10_000,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: true,
  });

  useEffect(() => {
    setShowConfirm(false);
    setMsg(null);
    setSelectedDex(null);
  }, [tokenIn, tokenOut, amount, direction]);

  const toggleWallet = (id: number) => {
    setSelectedWalletIds((prev) =>
      prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id]
    );
  };

  const totalSelectedBalance =
    wallets
      ?.filter((w) => selectedWalletIds.includes(w.id))
      .reduce((sum, w) => sum + w.balance, 0) ?? 0;

  const executeMutation = useMutation({
    mutationFn: async (data: {
      walletIds: number[];
      tokenIn: string;
      tokenOut: string;
      amountIn: number;
      direction: string;
      dex?: string;
    }) => {
      const results = await Promise.all(
        data.walletIds.map((walletId) =>
          apiFetch<{ txId: string; ok: boolean; dex?: string }>("/me/trades/execute", {
            method: "POST",
            body: JSON.stringify({
              walletId,
              tokenIn: data.tokenIn,
              tokenOut: data.tokenOut,
              amountIn: data.amountIn,
              direction: data.direction,
              dex: data.dex,
            }),
          })
        )
      );
      return results;
    },
    onSuccess: (results) => {
      const txIds = results.map((r) => r.txId?.slice(0, 10)).join(", ");
      setMsg({
        type: "success",
        text: `Executed across ${results.length} wallet(s)! TXs: ${txIds}...`,
      });
      setAmount("");
      setShowConfirm(false);
      queryClient.invalidateQueries({ queryKey: ["trades"] });
      queryClient.invalidateQueries({ queryKey: ["wallets"] });
    },
    onError: (err: Error) => setMsg({ type: "error", text: err.message }),
  });

  const handleSwap = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setDirection(direction === "BUY" ? "SELL" : "BUY");
  };

  const handleMax = () => {
    if (totalSelectedBalance > 0) {
      setAmount(totalSelectedBalance.toFixed(6));
    }
  };

  const handleExecute = () => {
    if (selectedWalletIds.length === 0 || !amount) return;
    setMsg(null);
    executeMutation.mutate({
      walletIds: selectedWalletIds,
      tokenIn,
      tokenOut,
      amountIn: parseFloat(amount),
      direction,
      dex: selectedDex || undefined,
    });
  };

  const activeQuote = quote
    ? (selectedDex
      ? quote.quotes?.find((q) => q.dex === selectedDex) || quote
      : quote)
    : null;

  const pricePerToken =
    activeQuote && parseFloat(amount) > 0 && activeQuote.amountOut > 0
      ? parseFloat(amount) / activeQuote.amountOut
      : null;
  const canExecute =
    selectedWalletIds.length > 0 && parseFloat(amount) > 0 && tokenIn !== tokenOut;

  return (
    <div>
      {/* Page header with tab bar */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-title-text">Trade</h2>
          <p className="text-muted-text mt-1 text-sm">
            Swap tokens and view your trade history
          </p>
        </div>
        <div className="flex items-center bg-input-bg border border-divider-color rounded-xl p-1 gap-1">
          <button
            onClick={() => setActiveTab("swap")}
            className={classNames(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all",
              activeTab === "swap"
                ? "bg-brand-500 text-white shadow"
                : "text-muted-text hover:text-title-text"
            )}
          >
            <ArrowRightLeft className="w-4 h-4" /> Swap
          </button>
          <button
            onClick={() => setActiveTab("history")}
            className={classNames(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all",
              activeTab === "history"
                ? "bg-brand-500 text-white shadow"
                : "text-muted-text hover:text-title-text"
            )}
          >
            <Receipt className="w-4 h-4" /> History
          </button>
        </div>
      </div>

      {activeTab === "history" && <TradeHistory />}

      {activeTab === "swap" && (
        <div className="max-w-lg mx-auto">
          <div className="bg-card-bg/80 backdrop-blur border border-card-border rounded-3xl p-1 space-y-1 shadow-2xl">
            {/* Multi-wallet selector */}
            <div className="px-4 pt-4 pb-2 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-text uppercase tracking-wider mb-1">
                <Wallet className="w-3.5 h-3.5" />
                <span>Select Wallets</span>
              </div>
              {!wallets?.length ? (
                <p className="text-xs text-muted-text/80 py-1">No wallets found.</p>
              ) : (
                <MultiWalletSelect
                  wallets={wallets}
                  selectedIds={selectedWalletIds}
                  onChange={setSelectedWalletIds}
                />
              )}
              {selectedWalletIds.length > 0 && (
                <p className="text-xs text-muted-text/80 pt-0.5">
                  {selectedWalletIds.length} wallet
                  {selectedWalletIds.length > 1 ? "s" : ""} selected &bull; Combined
                  balance: {totalSelectedBalance.toFixed(4)} STX
                </p>
              )}
              {selectedWalletIds.length > 1 && (
                <div className="mt-2 p-3 bg-blue-500/10 border border-blue-500/20 rounded-2xl text-xs text-blue-400 flex items-start gap-2">
                  <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div>
                    This transaction will execute individually on all {selectedWalletIds.length} selected wallets. Wallets with insufficient balance or missing tokens will fail.
                  </div>
                </div>
              )}
            </div>

            {/* You pay field */}
            <div className="bg-input-bg/40 rounded-2xl p-5 mx-2">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-muted-text uppercase tracking-wider">
                  {direction === "BUY" ? "You pay" : "You sell"}
                </span>
                <div className="flex items-center gap-2">
                  {selectedWalletIds.length > 0 && (
                    <span className="text-xs text-muted-text/85">
                      Balance: {totalSelectedBalance.toFixed(4)}
                    </span>
                  )}
                  <button
                    onClick={handleMax}
                    disabled={selectedWalletIds.length === 0}
                    className="px-2.5 py-1 bg-brand-500/15 hover:bg-brand-500/25 disabled:opacity-40 text-brand-400 rounded-lg text-xs font-medium transition-colors"
                  >
                    MAX
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  type="number"
                  step="any"
                  placeholder="0.00"
                  className="w-0 min-w-0 flex-1 bg-transparent text-3xl font-bold text-title-text placeholder-muted-text/50 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <TokenSelect
                  tokens={tokens}
                  value={tokenIn}
                  onChange={setTokenIn}
                  className="w-[130px] flex-shrink-0"
                />
              </div>
            </div>

            {/* Swap arrow */}
            <div className="flex justify-center -my-3 relative z-10">
              <button
                onClick={handleSwap}
                className="w-10 h-10 bg-input-bg border-4 border-card-bg rounded-2xl flex items-center justify-center hover:bg-bg-hover transition-all duration-200 hover:rotate-180"
              >
                <ArrowDownUp className="w-4 h-4 text-muted-text" />
              </button>
            </div>

            {/* You receive field */}
            <div className="bg-input-bg/40 rounded-2xl p-5 mx-2">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-muted-text uppercase tracking-wider">
                  You receive
                </span>
              </div>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1 text-3xl font-bold text-title-text">
                  {quoteLoading ? (
                    <Loader2 className="w-6 h-6 animate-spin text-muted-text mt-2" />
                  ) : activeQuote ? (
                    formatNumber(activeQuote.amountOut, 6)
                  ) : (
                    "—"
                  )}
                </div>
                <TokenSelect
                  tokens={tokens}
                  value={tokenOut}
                  onChange={setTokenOut}
                  className="w-[130px] flex-shrink-0"
                />
              </div>
              <div className="flex items-center justify-between mt-3">
                <span className="text-xs text-muted-text/80">
                  {pricePerToken
                    ? `1 ${tokenOut} ≈ ${pricePerToken.toFixed(4)} ${tokenIn}`
                    : ""}
                </span>
              </div>
            </div>

            {/* Route Selector */}
            {quote && quote.quotes && quote.quotes.length > 1 && (
              <div className="px-4 py-3 space-y-2 mx-2">
                <div className="text-xs font-semibold text-muted-text uppercase tracking-wider">
                  Select Routing Source
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {quote.quotes.map((q) => {
                    const isSelected = selectedDex ? selectedDex === q.dex : q.isBest;
                    return (
                      <button
                        key={q.dex}
                        onClick={() => setSelectedDex(q.dex)}
                        className={classNames(
                          "flex flex-col items-start p-3 rounded-2xl border text-left transition-all duration-200",
                          isSelected
                            ? "bg-brand-500/10 border-brand-500 text-title-text"
                            : "bg-input-bg/30 border-card-border hover:bg-input-bg/50 text-muted-text"
                        )}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className="text-xs font-bold text-title-text">{q.dex}</span>
                          {q.isBest && (
                            <span className="text-[10px] bg-brand-500 text-white font-semibold px-1.5 py-0.5 rounded-full">
                              Best
                            </span>
                          )}
                        </div>
                        <span className="text-sm font-black text-title-text mt-1">
                          {formatNumber(q.amountOut, 4)} {tokenOut}
                        </span>
                        <span className="text-[10px] opacity-85 mt-0.5">
                          Fee: {q.feeBps} bps
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Quote details */}
            {activeQuote && amount && (
              <div className="px-4 py-3 space-y-1.5">
                <div className="flex justify-between text-xs text-muted-text">
                  <span className="flex items-center gap-1">
                    <Info className="w-3 h-3" /> Rate
                  </span>
                  <span className="text-title-text">
                    {pricePerToken
                      ? `1 ${tokenIn} = ${(1 / pricePerToken).toFixed(6)} ${tokenOut}`
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-text">Fee</span>
                  <span className="text-title-text">
                    {activeQuote.feeAmount.toFixed(6)} {tokenIn} ({activeQuote.feeBps} bps)
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-text">Price Impact</span>
                  <span
                    className={classNames(
                      activeQuote.priceImpact > 2 ? "text-amber-400" : "text-muted-text"
                    )}
                  >
                    {activeQuote.priceImpact.toFixed(2)}%
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-text">Route</span>
                  <span className="text-brand-400 font-medium">
                    {activeQuote.dex ?? "—"}
                  </span>
                </div>
              </div>
            )}

            {/* Messages */}
            {msg && (
              <div
                className={classNames(
                  "mx-4 p-3 rounded-2xl text-sm",
                  msg.type === "success"
                    ? "bg-green-500/10 border border-green-500/20 text-green-400"
                    : "bg-red-500/10 border border-red-500/20 text-red-400"
                )}
              >
                {msg.text}
              </div>
            )}

            {/* Action buttons */}
            <div className="p-4">
              {!showConfirm ? (
                <button
                  onClick={() => canExecute && setShowConfirm(true)}
                  disabled={!canExecute}
                  className="w-full flex items-center justify-center gap-2 py-4 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white rounded-2xl font-semibold text-base transition-all duration-200 disabled:cursor-not-allowed"
                >
                  <Zap className="w-5 h-5" />
                  {selectedWalletIds.length === 0
                    ? "Select a wallet"
                    : !amount
                    ? "Enter an amount"
                    : tokenIn === tokenOut
                    ? "Select different tokens"
                    : `${direction} ${tokenOut} via ${
                        selectedWalletIds.length
                      } wallet${selectedWalletIds.length > 1 ? "s" : ""}`}
                </button>
              ) : (
                <div className="space-y-3">
                  <div className="bg-input-bg/50 rounded-2xl p-4 text-center text-sm text-muted-text">
                    Confirm swap of{" "}
                    <span className="text-title-text font-bold">
                      {parseFloat(amount).toFixed(4)} {tokenIn}
                    </span>{" "}
                    for{" "}
                    <span className="text-title-text font-bold">
                      ~{activeQuote?.amountOut.toFixed(4) ?? "..."} {tokenOut}
                    </span>
                    {selectedWalletIds.length > 1 && (
                      <span className="block text-xs text-muted-text/80 mt-1">
                        Executed across {selectedWalletIds.length} wallets individually.
                      </span>
                    )}
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setShowConfirm(false)}
                      className="flex-1 py-3 bg-input-bg hover:bg-bg-hover text-muted-text rounded-2xl font-medium text-sm transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleExecute}
                      disabled={executeMutation.isPending}
                      className="flex-1 py-3 bg-brand-500 hover:bg-brand-600 text-white rounded-2xl font-semibold text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {executeMutation.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" /> Confirming...
                        </>
                      ) : (
                        "Confirm Swap"
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
