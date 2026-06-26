import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  TrendingUp,
  Loader2,
  Wallet,
  CheckSquare,
  Square,
  AlertTriangle,
  Zap,
  Info,
  ChevronDown,
  Check,
} from "lucide-react";
import { apiFetch } from "../lib/api";
import { formatNumber, classNames } from "../lib/utils";
import { PerpPositionRow, type PerpPosition } from "./ui/PerpPositionRow";

interface WalletItem {
  id: number;
  address: string;
  name: string;
  balance: number;
}

const MARKETS = [
  { symbol: "BTC-USD", name: "Bitcoin / USD", entryPriceMock: 65000 },
  { symbol: "STX-USD", name: "Stacks / USD", entryPriceMock: 2.1 },
  { symbol: "ETH-USD", name: "Ethereum / USD", entryPriceMock: 3500 },
];

export function Perp() {
  const queryClient = useQueryClient();
  const [selectedWalletId, setSelectedWalletId] = useState<number | null>(null);
  const [market, setMarket] = useState("BTC-USD");
  const [direction, setDirection] = useState<"LONG" | "SHORT">("LONG");
  const [margin, setMargin] = useState("");
  const [leverage, setLeverage] = useState(5);
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [closingId, setClosingId] = useState<number | null>(null);

  const [walletDropdownOpen, setWalletDropdownOpen] = useState(false);
  const walletRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (walletRef.current && !walletRef.current.contains(e.target as Node)) {
        setWalletDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const { data: wallets = [], isLoading: walletsLoading } = useQuery<WalletItem[]>({
    queryKey: ["wallets"],
    queryFn: () => apiFetch("/me/wallets"),
  });

  const { data: positions = [], isLoading: positionsLoading } = useQuery<PerpPosition[]>({
    queryKey: ["perp-positions"],
    queryFn: () => apiFetch("/me/perp/positions"),
    refetchInterval: 10_000,
  });

  const selectedWallet = wallets.find((w) => w.id === selectedWalletId);
  const selectedMarketObj = MARKETS.find((m) => m.symbol === market) || MARKETS[0];
  const entryPrice = selectedMarketObj.entryPriceMock;

  // Liquidation Price calculation:
  // Long: entryPrice * (1 - 1 / leverage) / (1 - marginMaintenance)
  // Short: entryPrice * (1 + 1 / leverage) / (1 + marginMaintenance)
  const marginMaintenance = 0.025;
  const liquidationPrice = direction === "LONG"
    ? entryPrice * (1 - 1 / leverage) / (1 - marginMaintenance)
    : entryPrice * (1 + 1 / leverage) / (1 + marginMaintenance);

  const openMutation = useMutation({
    mutationFn: (data: {
      walletId: number;
      market: string;
      direction: "LONG" | "SHORT";
      margin: number;
      leverage: number;
    }) =>
      apiFetch("/me/perp/positions", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      setMsg({ type: "success", text: "Perpetual position opened successfully!" });
      setMargin("");
      queryClient.invalidateQueries({ queryKey: ["perp-positions"] });
      queryClient.invalidateQueries({ queryKey: ["wallets"] });
    },
    onError: (err: Error) => setMsg({ type: "error", text: err.message }),
  });

  const closeMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/me/perp/positions/${id}/close`, {
        method: "POST",
      }),
    onSuccess: () => {
      setMsg({ type: "success", text: "Perpetual position closed successfully!" });
      setClosingId(null);
      queryClient.invalidateQueries({ queryKey: ["perp-positions"] });
      queryClient.invalidateQueries({ queryKey: ["wallets"] });
    },
    onError: (err: Error) => {
      setMsg({ type: "error", text: err.message });
      setClosingId(null);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWalletId || !margin) return;
    setMsg(null);
    openMutation.mutate({
      walletId: selectedWalletId,
      market,
      direction,
      margin: parseFloat(margin),
      leverage,
    });
  };

  const handleClose = (id: number) => {
    setMsg(null);
    setClosingId(id);
    closeMutation.mutate(id);
  };

  const maxMargin = selectedWallet ? selectedWallet.balance : 0;
  const isFormValid =
    selectedWalletId !== null &&
    parseFloat(margin) > 0 &&
    parseFloat(margin) <= maxMargin;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-title-text flex items-center gap-2">
          <TrendingUp className="w-6 h-6 text-brand-500" /> Perpetual Leverage Trading
        </h2>
        <p className="text-muted-text mt-1 text-sm">
          Long or short assets with up to 20x leverage on Stacks
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Side: Order Form */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-card-bg/85 backdrop-blur border border-card-border rounded-3xl p-6 shadow-2xl space-y-6">
            <h3 className="text-lg font-bold text-title-text border-b border-divider-color pb-3">
              Open Leveraged Position
            </h3>

            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Wallet Selector */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-text uppercase tracking-wider block">
                  Select Wallet
                </label>
                {walletsLoading ? (
                  <div className="py-4 text-xs text-muted-text flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-brand-500" /> Loading wallets...
                  </div>
                ) : wallets.length === 0 ? (
                  <p className="text-xs text-muted-text">No wallets available.</p>
                ) : (
                  <div ref={walletRef} className="relative">
                    <button
                      type="button"
                      onClick={() => setWalletDropdownOpen(!walletDropdownOpen)}
                      className="w-full flex items-center justify-between gap-2 px-4 py-3 bg-input-bg border border-divider-color rounded-2xl text-sm text-title-text hover:border-brand-500/50 transition-all duration-200"
                    >
                      <div className="flex items-center gap-2">
                        <Wallet className="w-4 h-4 text-muted-text" />
                        <span className={selectedWallet ? "text-title-text font-medium" : "text-muted-text/60"}>
                          {selectedWallet ? selectedWallet.name : "Select wallet..."}
                        </span>
                        {selectedWallet && (
                          <span className="text-xs text-muted-text/80 ml-1">
                            ({formatNumber(selectedWallet.balance, 4)} STX)
                          </span>
                        )}
                      </div>
                      <ChevronDown className={classNames("w-4 h-4 text-muted-text transition-transform duration-200", walletDropdownOpen && "rotate-180")} />
                    </button>

                    {walletDropdownOpen && (
                      <div className="absolute z-50 mt-2 w-full bg-card-bg border border-card-border rounded-2xl shadow-2xl overflow-hidden">
                        <div className="max-h-56 overflow-y-auto">
                          {wallets.map((w) => {
                            const sel = selectedWalletId === w.id;
                            return (
                              <button
                                key={w.id}
                                type="button"
                                onClick={() => {
                                  setSelectedWalletId(w.id);
                                  setWalletDropdownOpen(false);
                                }}
                                className={classNames(
                                  "w-full flex items-center gap-3 px-4 py-3 text-sm text-left hover:bg-bg-hover transition-colors",
                                  sel && "bg-brand-500/5"
                                )}
                              >
                                <div className={classNames(
                                  "w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors",
                                  sel ? "bg-brand-500 border-brand-500" : "border-divider-color"
                                )}>
                                  {sel && <Check className="w-3 h-3 text-white" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <span className="font-medium text-title-text">{w.name}</span>
                                  <span className="text-muted-text ml-2 text-xs">{formatNumber(w.balance, 4)} STX</span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Market & Direction */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-muted-text uppercase tracking-wider block">
                    Market
                  </label>
                  <select
                    value={market}
                    onChange={(e) => setMarket(e.target.value)}
                    className="w-full px-3 py-2 bg-input-bg border border-divider-color rounded-xl text-sm text-title-text focus:border-brand-500 focus:outline-none"
                  >
                    {MARKETS.map((m) => (
                      <option key={m.symbol} value={m.symbol}>
                        {m.symbol}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-semibold text-muted-text uppercase tracking-wider block">
                    Direction
                  </label>
                  <div className="flex bg-input-bg border border-divider-color rounded-xl p-0.5">
                    <button
                      type="button"
                      onClick={() => setDirection("LONG")}
                      className={classNames(
                        "flex-1 py-1.5 rounded-lg text-xs font-bold transition-all",
                        direction === "LONG"
                          ? "bg-emerald-500 text-white"
                          : "text-muted-text hover:text-title-text"
                      )}
                    >
                      LONG
                    </button>
                    <button
                      type="button"
                      onClick={() => setDirection("SHORT")}
                      className={classNames(
                        "flex-1 py-1.5 rounded-lg text-xs font-bold transition-all",
                        direction === "SHORT"
                          ? "bg-rose-500 text-white"
                          : "text-muted-text hover:text-title-text"
                      )}
                    >
                      SHORT
                    </button>
                  </div>
                </div>
              </div>

              {/* Margin Amount */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-semibold text-muted-text uppercase tracking-wider block">
                    Margin (STX)
                  </label>
                  {selectedWallet && (
                    <span className="text-xs text-muted-text">
                      Max: {formatNumber(maxMargin, 4)} STX
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    type="number"
                    step="any"
                    value={margin}
                    onChange={(e) => setMargin(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2.5 bg-input-bg border border-divider-color rounded-xl text-sm text-title-text placeholder:text-muted-text focus:border-brand-500 focus:outline-none"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setMargin(maxMargin.toString())}
                    disabled={!selectedWallet}
                    className="px-3 bg-brand-500/10 hover:bg-brand-500/20 text-brand-400 disabled:opacity-40 text-xs font-bold rounded-xl border border-brand-500/20 transition-colors"
                  >
                    MAX
                  </button>
                </div>
              </div>

              {/* Leverage Selector */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-semibold text-muted-text uppercase tracking-wider block">
                    Leverage
                  </label>
                  <span className="text-sm font-bold text-brand-400">{leverage}x</span>
                </div>
                <input
                  type="range"
                  min="2"
                  max="20"
                  value={leverage}
                  onChange={(e) => setLeverage(parseInt(e.target.value, 10))}
                  className="w-full accent-brand-500 h-1.5 bg-input-bg rounded-lg cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-muted-text font-bold">
                  <span>2x</span>
                  <span>5x</span>
                  <span>10x</span>
                  <span>15x</span>
                  <span>20x</span>
                </div>
              </div>

              {/* Price Previews */}
              <div className="p-3 bg-input-bg/30 border border-divider-color rounded-xl text-xs space-y-2">
                <div className="flex justify-between text-muted-text">
                  <span>Est. Entry Price</span>
                  <span className="font-semibold text-title-text">
                    ${formatNumber(entryPrice, 2)}
                  </span>
                </div>
                <div className="flex justify-between text-muted-text">
                  <span>Est. Liquidation Price</span>
                  <span className="font-semibold text-rose-400">
                    ${formatNumber(liquidationPrice, 2)}
                  </span>
                </div>
                <div className="flex justify-between text-muted-text border-t border-divider-color pt-2 mt-1">
                  <span>Total Position Size</span>
                  <span className="font-bold text-title-text">
                    {formatNumber(parseFloat(margin || "0") * leverage, 2)} STX
                  </span>
                </div>
              </div>

              {/* Feedback Message */}
              {msg && (
                <div
                  className={classNames(
                    "p-3 rounded-xl text-xs border",
                    msg.type === "success"
                      ? "bg-green-500/10 border-green-500/20 text-green-400"
                      : "bg-red-500/10 border-red-500/20 text-red-400"
                  )}
                >
                  {msg.text}
                </div>
              )}

              {/* Submit Button */}
              <button
                type="submit"
                disabled={!isFormValid || openMutation.isPending}
                className="w-full py-3 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white rounded-xl font-bold text-sm transition-all duration-200 flex items-center justify-center gap-2"
              >
                {openMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Opening Position...
                  </>
                ) : (
                  <>
                    <Zap className="w-4 h-4" /> Open {direction} Position
                  </>
                )}
              </button>
            </form>
          </div>
        </div>

        {/* Right Side: Open Positions List */}
        <div className="lg:col-span-7 space-y-6">
          <div className="bg-card-bg/85 backdrop-blur border border-card-border rounded-3xl p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-title-text border-b border-divider-color pb-3 mb-4">
              Your Perpetual Positions
            </h3>

            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-divider-color text-muted-text text-xs uppercase font-medium">
                    <th className="py-3 px-4">Market</th>
                    <th className="py-3 px-4">Type</th>
                    <th className="py-3 px-4">Size / Margin</th>
                    <th className="py-3 px-4">Lev</th>
                    <th className="py-3 px-4">Entry</th>
                    <th className="py-3 px-4">Liq Price</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Tx</th>
                    <th className="py-3 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {positionsLoading ? (
                    <tr>
                      <td colSpan={9} className="py-12 text-center text-xs text-muted-text">
                        <div className="flex items-center justify-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin text-brand-400" />
                          <span>Loading perp positions...</span>
                        </div>
                      </td>
                    </tr>
                  ) : positions.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-12 text-center text-sm text-muted-text">
                        No active perpetual positions.
                      </td>
                    </tr>
                  ) : (
                    positions.map((pos) => (
                      <PerpPositionRow
                        key={pos.id}
                        position={pos}
                        onClose={handleClose}
                        isClosing={closingId === pos.id}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
