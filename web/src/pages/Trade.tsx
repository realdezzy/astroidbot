import { useState, useEffect, useRef } from "react";
import { useSearchParams, Link } from "react-router-dom";
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
  Share2,
  CheckCircle2,
  Clock,
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
  isDefault?: boolean;
  chainId?: string;
  chain?: string;
  chainFamily?: string;
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
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<TradeTab>("swap");
  const [selectedWalletIds, setSelectedWalletIds] = useState<number[]>([]);
  const [direction, setDirection] = useState<"BUY" | "SELL">("BUY");

  // Deep-link prefill from the token discovery pages: /trade?chainId=…&tokenOut=…
  // The whole point of the discovery flow is that a user arrives here with
  // everything chosen and only has to type an amount.
  const prefillChainId = searchParams.get("chainId");
  const prefillTokenIn = searchParams.get("tokenIn");
  const prefillTokenOut = searchParams.get("tokenOut");
  const confirmToken = searchParams.get("confirm");

  // The chain this trade is on. Everything below is scoped to it: the token
  // list, the quote, and which wallets can be selected.
  //
  // Previously there was no chain at all — tokenIn defaulted to "STX" and
  // tokenOut to "USDCx" whatever wallet you held, the token list came from an
  // unscoped /tokens, and the quote asked every provider on every chain. On a
  // Stacks-only deployment that was invisible; with three chains enabled it
  // means a Base wallet offered Stacks tokens.
  const [chainId, setChainId] = useState<string | null>(prefillChainId);
  const [tokenIn, setTokenIn] = useState(prefillTokenIn ?? "");
  const [tokenOut, setTokenOut] = useState(prefillTokenOut ?? "");
  const [amount, setAmount] = useState("");
  const [prefillNotice, setPrefillNotice] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [selectedDex, setSelectedDex] = useState<string | null>(null);

  const { data: pendingSocialData, isLoading: pendingSocialLoading } = useQuery<{
    ok: boolean;
    command: {
      id: number;
      platform: string;
      rawText: string;
      parsedIntent: {
        action: "buy" | "sell";
        amount: number;
        token: string;
      } | null;
      confirmExpiresAt: string;
    };
  }>({
    queryKey: ["pending-social-command", confirmToken],
    queryFn: () => apiFetch(`/me/social-commands/confirm?token=${confirmToken}`),
    enabled: !!confirmToken,
  });

  const confirmSocialMutation = useMutation({
    mutationFn: (token: string) =>
      apiFetch<{ ok: boolean; message: string }>("/me/social-commands/confirm", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    onSuccess: (data) => {
      setMsg({ type: "success", text: data.message || "Social trade confirmed and enqueued!" });
      queryClient.invalidateQueries({ queryKey: ["trades"] });
      queryClient.invalidateQueries({ queryKey: ["wallets"] });
    },
    onError: (err: Error) => {
      setMsg({ type: "error", text: err.message || "Failed to confirm social trade" });
    },
  });

  const { data: chainData } = useQuery<{
    chains: {
      chainId: string;
      displayName: string;
      nativeSymbol: string;
      stableSymbol: string;
      tradable: boolean;
    }[];
  }>({
    queryKey: ["chains"],
    queryFn: () => apiFetch("/chains"),
    staleTime: 5 * 60_000,
  });

  const chains = (chainData?.chains ?? []).filter((c) => c.tradable);
  const activeChain = chains.find((c) => c.chainId === chainId) ?? null;

  // Scoped to the chain. Unscoped, this returned every chain's tokens, so a
  // Base wallet's picker offered Stacks tokens that could never route.
  const { data: tokensData } = useQuery<{ tokens: Token[] }>({
    queryKey: ["tokens", chainId],
    queryFn: () => apiFetch(chainId ? `/tokens?chainId=${encodeURIComponent(chainId)}` : "/tokens"),
    enabled: chainId !== null,
  });

  const { data: wallets, isLoading: walletsLoading } = useQuery<WalletItem[]>({
    queryKey: ["wallets"],
    queryFn: () => apiFetch("/me/wallets"),
  });

  const tokens = tokensData?.tokens ?? [];

  // Wallets are filtered to the chain: a trade executes from one of these, and
  // a wallet on another chain cannot run it.
  const chainWallets = (wallets ?? []).filter((w) => !chainId || w.chain === chainId);

  /**
   * Default the chain from the user's wallets, then the token pair from that
   * chain's own native and stable assets.
   *
   * Both were hardcoded to Stacks ("STX" / "USDCx") whatever the user held.
   */
  useEffect(() => {
    if (chainId || !wallets?.length) return;
    // The user's default wallet, not whichever the API listed first — that is
    // an arbitrary chain to open the trade form on.
    const preferred = wallets.find((w) => w.isDefault) ?? wallets[0]!;
    setChainId(preferred.chain ?? null);
  }, [chainId, wallets]);

  useEffect(() => {
    if (!activeChain) return;
    const { nativeSymbol, stableSymbol } = activeChain;

    // Fill only the side the deep link left empty, and never with the token
    // already on the other side. Arriving from the token pages with
    // `tokenOut=CELO` — the chain's own native asset, which the discovery
    // table lists like any other — used to default `tokenIn` to CELO as well
    // and render a CELO → CELO swap the form was happy to quote.
    setTokenIn((current) => {
      if (current) return current;
      return tokenOut === nativeSymbol ? stableSymbol : nativeSymbol;
    });
    setTokenOut((current) => {
      if (current) return current;
      return tokenIn === stableSymbol ? nativeSymbol : stableSymbol;
    });
    // tokenIn/tokenOut are read to avoid colliding, but adding them as
    // dependencies would re-run this on every user edit and fight the input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChain]);

  // Selecting a chain drops a wallet that isn't on it, rather than leaving a
  // selection that would fail at execution.
  useEffect(() => {
    setSelectedWalletIds((ids) =>
      ids.filter((id) => chainWallets.some((w) => w.id === id))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId]);

  const tokenInObj = tokens.find(t => t.contractId === tokenIn || t.symbol === tokenIn);
  const tokenInSymbol = tokenInObj ? tokenInObj.symbol : tokenIn;

  const { data: quote, isFetching: quoteLoading, error: quoteError } = useQuery<QuoteResult, Error>({
    queryKey: ["quote", tokenIn, tokenOut, amount, selectedWalletIds[0] ?? chainId],
    queryFn: () => {
      const params = new URLSearchParams({ tokenIn, tokenOut, amountIn: amount });
      // The wallet is what the trade executes from, so it is what the quote
      // must be scoped to. Without it the server asked every provider on every
      // chain and returned whichever answered first.
      if (selectedWalletIds[0]) params.set("walletId", String(selectedWalletIds[0]));
      else if (chainId) params.set("chainId", chainId);
      return apiFetch(`/me/trades/quote?${params}`);
    },
    enabled:
      !!tokenIn &&
      !!tokenOut &&
      !!amount &&
      parseFloat(amount) > 0 &&
      tokenIn !== tokenOut,
    refetchInterval: 120_000,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: true,
  });

  const { data: walletsBalances = {} } = useQuery<Record<number, Record<string, number>>>({
    queryKey: ["wallets-balances", wallets?.map((w) => w.id), tokenInSymbol],
    queryFn: async () => {
      if (!wallets) return {};
      const results = await Promise.all(
        wallets.map(async (w) => {
          try {
            const res = await apiFetch<Array<{ token: string; symbol: string; balance: number; usdValue: number }>>(
              `/me/wallets/${w.id}/balances`
            );
            return { walletId: w.id, balances: res };
          } catch {
            return { walletId: w.id, balances: [] };
          }
        })
      );
      const map: Record<number, Record<string, number>> = {};
      results.forEach((r) => {
        map[r.walletId] = {};
        r.balances.forEach((b) => {
          map[r.walletId]![b.symbol.toUpperCase()] = b.balance;
        });
      });
      return map;
    },
    enabled: !!wallets && wallets.length > 0,
    refetchInterval: 30000,
  });

  useEffect(() => {
    setShowConfirm(false);
    setSelectedDex(null);
  }, [tokenIn, tokenOut, amount, direction]);

  // Deep-link arrival: pick a wallet on the requested chain and focus the
  // amount field, so the user's only remaining action is typing a number.
  // Runs once — after that the user's own wallet choice must win.
  const prefillApplied = useRef(false);
  useEffect(() => {
    if (prefillApplied.current) return;
    if (!prefillChainId || !wallets || wallets.length === 0) return;
    prefillApplied.current = true;

    const walletChain = (w: WalletItem) => w.chainId ?? w.chain;
    const compatible = wallets.filter((w) => walletChain(w) === prefillChainId);

    if (compatible.length === 0) {
      // Don't silently trade on the wrong chain. Say so, and leave the user to
      // create a wallet — a same-ticker token on another chain is a different
      // asset entirely.
      setPrefillNotice(
        `You have no wallet on ${prefillChainId}. Create one to trade this token.`
      );
      return;
    }

    const preferred = compatible.find((w) => w.balance > 0) ?? compatible[0]!;
    setSelectedWalletIds([preferred.id]);
    amountRef.current?.focus();
  }, [prefillChainId, wallets]);

  const toggleWallet = (id: number) => {
    setMsg(null);
    setSelectedWalletIds((prev) =>
      prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id]
    );
  };

  // Summed only over the wallets on the selected chain — `chainWallets` is
  // already filtered, so this cannot add an ETH balance to an STX one.
  const totalSelectedNativeBalance =
    chainWallets
      .filter((w) => selectedWalletIds.includes(w.id))
      .reduce((sum, w) => sum + w.balance, 0) ?? 0;

  // The native leg is whatever this chain calls it, not "STX". On Base the
  // literal sent every native-ETH trade down the token-balance branch, which
  // looked right only because the balances map happens to carry ETH too.
  const combinedBalance = tokenIn === activeChain?.nativeSymbol
    ? totalSelectedNativeBalance
    : selectedWalletIds.reduce((sum, id) => {
      const wBalances = walletsBalances[id];
      if (!wBalances) return sum;
      const symbol = tokenInSymbol.toUpperCase();
      return sum + (wBalances[symbol] ?? 0);
    }, 0);

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
      queryClient.invalidateQueries({ queryKey: ["wallets-balances"] });
    },
    onError: (err: Error) => setMsg({ type: "error", text: err.message }),
  });

  const handleSwap = () => {
    setMsg(null);
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setDirection(direction === "BUY" ? "SELL" : "BUY");
  };

  const handleMax = () => {
    if (combinedBalance > 0) {
      setMsg(null);
      setAmount(combinedBalance.toFixed(6));
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
  const parsedAmount = parseFloat(amount) || 0;
  const isInsufficientBalance = selectedWalletIds.length > 0 && parsedAmount > combinedBalance;

  const canExecute =
    selectedWalletIds.length > 0 &&
    parsedAmount > 0 &&
    !isInsufficientBalance &&
    tokenIn !== tokenOut &&
    !!activeQuote;

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
        <div className="max-w-lg mx-auto space-y-4">
          {/* Chain selector.
            *
            * The page had none: tokens, defaults and the quote were all
            * implicitly Stacks, so holding a Base wallet gave you a Stacks
            * token picker and a quote for a trade that could not execute.
            * Everything below is scoped to whatever is chosen here. */}
          {chains.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {chains.map((c) => (
                <button
                  key={c.chainId}
                  onClick={() => {
                    setChainId(c.chainId);
                    // Cleared rather than carried over: a symbol from the old
                    // chain is at best unroutable here and at worst a
                    // different asset with the same ticker.
                    setTokenIn(c.nativeSymbol);
                    setTokenOut(c.stableSymbol);
                    setAmount("");
                  }}
                  className={classNames(
                    "px-3 py-1.5 rounded-full text-xs font-semibold transition-colors",
                    chainId === c.chainId
                      ? "bg-brand-500 text-white"
                      : "bg-card-bg text-muted-text hover:text-title-text"
                  )}
                >
                  {c.displayName}
                </button>
              ))}
            </div>
          )}

          {/* Only once the query has settled. The wallets endpoint reads live
            * balances per chain and takes seconds, and rendering the empty
            * state meanwhile told users to create a wallet they already had —
            * then swapped it for their wallet a moment later. */}
          {chainId && !walletsLoading && chainWallets.length === 0 && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
              No wallet on {activeChain?.displayName ?? chainId}. Create one before trading here.{" "}
              <Link to="/wallets" className="underline hover:no-underline">
                Go to Wallets
              </Link>
            </div>
          )}

          {/* Pending Social Trade Banner */}
          {confirmToken && (
            <div className="bg-gradient-to-r from-violet-900/40 via-brand-950/40 to-violet-900/40 border border-violet-500/30 rounded-3xl p-5 space-y-3 backdrop-blur shadow-xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Share2 className="w-5 h-5 text-violet-400" />
                  <span className="text-sm font-bold text-title-text uppercase tracking-wider">
                    Social Trade Authorization
                  </span>
                </div>
                <span className="flex items-center gap-1 text-xs text-amber-400 font-medium bg-amber-500/10 px-2.5 py-1 rounded-full border border-amber-500/20">
                  <Clock className="w-3.5 h-3.5" /> 5-Min TTL
                </span>
              </div>

              {pendingSocialLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-text py-2">
                  <Loader2 className="w-4 h-4 animate-spin text-violet-400" /> Loading mention details...
                </div>
              ) : pendingSocialData?.command ? (
                <div className="space-y-3">
                  <p className="text-xs text-muted-text/90 italic bg-input-bg/60 p-3 rounded-2xl border border-divider-color/40">
                    &quot;{pendingSocialData.command.rawText}&quot;
                  </p>
                  <div className="flex items-center justify-between text-xs text-title-text font-medium bg-violet-500/10 p-3 rounded-2xl border border-violet-500/20">
                    <span>Requested Command:</span>
                    <span className="font-bold text-violet-300 uppercase">
                      {pendingSocialData.command.parsedIntent?.action}{" "}
                      {pendingSocialData.command.parsedIntent?.amount}{" "}
                      {pendingSocialData.command.parsedIntent?.token}
                    </span>
                  </div>
                  <button
                    onClick={() => confirmSocialMutation.mutate(confirmToken)}
                    disabled={confirmSocialMutation.isPending}
                    className="w-full py-3 bg-gradient-to-r from-violet-600 to-brand-500 hover:from-violet-500 hover:to-brand-400 text-white font-bold text-sm rounded-2xl flex items-center justify-center gap-2 transition-all shadow-lg disabled:opacity-50"
                  >
                    {confirmSocialMutation.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" /> Authorizing...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-4 h-4" /> Confirm & Execute Social Trade
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <p className="text-xs text-red-400">
                  Invalid or expired confirmation link. Please check your social post reply for updated details.
                </p>
              )}
            </div>
          )}

          <div className="bg-card-bg/80 backdrop-blur border border-card-border rounded-3xl p-1 space-y-1 shadow-2xl">
            {/* Multi-wallet selector */}
            <div className="px-4 pt-4 pb-2 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-text uppercase tracking-wider mb-1">
                <Wallet className="w-3.5 h-3.5" />
                <span>Select Wallets</span>
              </div>
              {!chainWallets.length ? (
                <p className="text-xs text-muted-text/80 py-1">
                  {wallets?.length
                    ? `No wallet on ${activeChain?.displayName ?? "this chain"}.`
                    : "No wallets found."}
                </p>
              ) : (
                <MultiWalletSelect
                  // Only wallets on the selected chain: a trade executes from
                  // one of these, and one on another chain cannot run it.
                  wallets={chainWallets}
                  selectedIds={selectedWalletIds}
                  onChange={(ids) => {
                    setSelectedWalletIds(ids);
                    setMsg(null);
                  }}
                  balances={walletsBalances}
                  tokenSymbol={tokenInSymbol}
                />
              )}
              {selectedWalletIds.length > 0 && (
                <p className="text-xs text-muted-text/80 pt-0.5">
                  {selectedWalletIds.length} wallet
                  {selectedWalletIds.length > 1 ? "s" : ""} selected &bull; Combined
                  balance: {combinedBalance.toFixed(4)} {tokenInSymbol}
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
                      Balance: {combinedBalance.toFixed(4)}
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
                  ref={amountRef}
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setMsg(null);
                  }}
                  type="number"
                  step="any"
                  placeholder="0.00"
                  className="w-0 min-w-0 flex-1 bg-transparent text-3xl font-bold text-title-text placeholder-muted-text/50 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <TokenSelect
                  tokens={tokens}
                  chainId={chainId ?? undefined}
                  value={tokenIn}
                  onChange={(v) => {
                    setTokenIn(v);
                    setMsg(null);
                  }}
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
                  chainId={chainId ?? undefined}
                  value={tokenOut}
                  onChange={(v) => {
                    setTokenOut(v);
                    setMsg(null);
                  }}
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
            {quoteError && (
              <div className="mx-4 p-3 rounded-2xl text-sm bg-red-500/10 border border-red-500/20 text-red-400">
                Failed to fetch quote: {quoteError.message}
              </div>
            )}

            {prefillNotice && (
              <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                {prefillNotice}
              </div>
            )}
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
                        : isInsufficientBalance
                          ? `Insufficient ${tokenInSymbol} balance`
                          : `${direction} ${tokenOut} via ${selectedWalletIds.length
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
