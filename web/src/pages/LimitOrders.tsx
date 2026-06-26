import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Clock, Zap } from "lucide-react";
import { apiFetch } from "../lib/api";
import { formatDate, classNames } from "../lib/utils";
import { AutoRefreshToggle } from "../components/AutoRefreshToggle";
import { TokenSelect } from "../components/TokenSelect";
import { MultiWalletSelect } from "../components/MultiWalletSelect";
import { useAutoRefresh } from "../hooks/useAutoRefresh";

interface LimitOrder {
  id: number;
  walletId: number;
  tokenIn: string;
  tokenOut: string;
  direction: string;
  targetPrice: number;
  amountIn: number;
  status: string;
  forceAfter: string | null;
  expiresAt: string | null;
  createdAt: string;
  filledAt: string | null;
  txId: string | null;
}

interface Wallet {
  id: number;
  name: string;
  address: string;
  balance: number;
}

export function LimitOrders() {
  const queryClient = useQueryClient();
  const { isActive, toggle, timeLeft, interval } = useAutoRefresh("limitOrders");
  const [showForm, setShowForm] = useState(false);

  const [form, setForm] = useState({
    walletIds: [] as number[],
    tokenIn: "STX",
    tokenOut: "sUSDT",
    direction: "BUY",
    targetPrice: 0,
    amountIn: 0,
    forceAfterMinutes: "",
  });

  const { data: wallets } = useQuery<Wallet[]>({
    queryKey: ["wallets"],
    queryFn: () => apiFetch("/me/wallets"),
  });

  const { data: tokensData } = useQuery<{ tokens: { contractId: string; symbol: string; name: string; decimals: number }[] }>({
    queryKey: ["tokens"],
    queryFn: () => apiFetch("/tokens"),
  });

  const tokens = tokensData?.tokens ?? [];

  const { data: ordersData, isLoading } = useQuery<{ orders: LimitOrder[] }>({
    queryKey: ["limit-orders"],
    queryFn: () => apiFetch("/me/limit-orders"),
    refetchInterval: interval,
  });

  const createMutation = useMutation({
    mutationFn: (data: {
      walletIds: number[];
      tokenIn: string;
      tokenOut: string;
      direction: string;
      targetPrice: number;
      amountIn: number;
      forceAfter?: string;
    }) =>
      apiFetch("/me/limit-orders", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["limit-orders"] });
      setShowForm(false);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/me/limit-orders/${id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["limit-orders"] });
    },
  });

  const handleCreate = () => {
    if (form.walletIds.length === 0 || !form.targetPrice || !form.amountIn) return;

    createMutation.mutate({
      walletIds: form.walletIds,
      tokenIn: form.tokenIn,
      tokenOut: form.tokenOut,
      direction: form.direction,
      targetPrice: form.targetPrice,
      amountIn: form.amountIn,
      forceAfter: form.forceAfterMinutes
        ? new Date(Date.now() + parseInt(form.forceAfterMinutes) * 60000).toISOString()
        : undefined,
    });
  };

  const orders = ordersData?.orders ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-bold text-title-text">Limit Orders</h2>
          <p className="text-muted-text mt-1">
            Price-triggered buy and sell orders
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AutoRefreshToggle
            isActive={isActive}
            toggle={toggle}
            timeLeft={timeLeft}
          />
          <button
            onClick={() => setShowForm(!showForm)}
            className={classNames(
              "flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-colors",
              showForm
                ? "bg-input-bg text-muted-text"
                : "bg-brand-500 hover:bg-brand-600 text-white"
            )}
          >
            <Plus className="w-4 h-4" />
            New Order
          </button>
        </div>
      </div>

      {showForm && (
        <div className="bg-card-bg border border-card-border rounded-xl p-6 mb-6">
          <h3 className="text-sm font-semibold text-muted-text uppercase tracking-wider mb-4">
            Create Limit Order
          </h3>
          <div className="grid grid-cols-4 gap-4">
            <div>
              <label className="block text-xs text-muted-text mb-1">Wallets</label>
              <MultiWalletSelect
                wallets={wallets ?? []}
                selectedIds={form.walletIds}
                onChange={(ids) => setForm((f) => ({ ...f, walletIds: ids }))}
              />
            </div>
            <div>
              <label className="block text-xs text-muted-text mb-1">Token In</label>
              <TokenSelect tokens={tokens} value={form.tokenIn} onChange={(v) => setForm((f) => ({ ...f, tokenIn: v }))} />
            </div>
            <div>
              <label className="block text-xs text-muted-text mb-1">Token Out</label>
              <TokenSelect tokens={tokens} value={form.tokenOut} onChange={(v) => setForm((f) => ({ ...f, tokenOut: v }))} />
            </div>
            <div>
              <label className="block text-xs text-muted-text mb-1">Direction</label>
              <div className="flex gap-1">
                <button
                  onClick={() => setForm((f) => ({ ...f, direction: "BUY" }))}
                  className={classNames(
                    "flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors",
                    form.direction === "BUY"
                      ? "bg-green-500/20 text-green-400 border border-green-500/30"
                      : "bg-input-bg text-muted-text border border-divider-color"
                  )}
                >
                  BUY
                </button>
                <button
                  onClick={() => setForm((f) => ({ ...f, direction: "SELL" }))}
                  className={classNames(
                    "flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors",
                    form.direction === "SELL"
                      ? "bg-red-500/20 text-red-400 border border-red-500/30"
                      : "bg-input-bg text-muted-text border border-divider-color"
                  )}
                >
                  SELL
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs text-muted-text mb-1">Target Price (USD)</label>
              <input
                type="number"
                step="0.01"
                value={form.targetPrice || ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, targetPrice: parseFloat(e.target.value) || 0 }))
                }
                className="w-full px-3 py-2 bg-input-bg border border-divider-color rounded-lg text-sm text-title-text focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-text mb-1">Amount</label>
              <input
                type="number"
                step="0.01"
                value={form.amountIn || ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, amountIn: parseFloat(e.target.value) || 0 }))
                }
                className="w-full px-3 py-2 bg-input-bg border border-divider-color rounded-lg text-sm text-title-text focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-text mb-1">
                Force After (min, optional)
              </label>
              <input
                type="number"
                value={form.forceAfterMinutes}
                onChange={(e) =>
                  setForm((f) => ({ ...f, forceAfterMinutes: e.target.value }))
                }
                className="w-full px-3 py-2 bg-input-bg border border-divider-color rounded-lg text-sm text-title-text focus:border-brand-500 focus:outline-none"
                placeholder="Execute after X minutes"
              />
            </div>
            <div className="flex items-end">
              <button
                onClick={handleCreate}
                disabled={createMutation.isPending}
                className="w-full px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
              >
                {createMutation.isPending ? "Creating..." : "Create Order"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="glass-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-divider-color text-muted-text">
              <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                Created
              </th>
              <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                Direction
              </th>
              <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                From → To
              </th>
              <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                Target Price
              </th>
              <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                Amount
              </th>
              <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                Status
              </th>
              <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-muted-text">
                  Loading...
                </td>
              </tr>
            ) : orders.length > 0 ? (
              orders.map((order) => (
                <tr
                  key={order.id}
                  className="border-b border-divider-color hover:bg-bg-hover/50 transition-colors"
                >
                  <td className="py-3 px-4 text-sm text-muted-text">
                    {formatDate(order.createdAt)}
                  </td>
                  <td className="py-3 px-4">
                    <span
                      className={classNames(
                        "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium",
                        order.direction === "BUY"
                          ? "text-green-400 bg-green-500/10"
                          : "text-red-400 bg-red-500/10"
                      )}
                    >
                      {order.direction}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-sm text-title-text">
                    {order.tokenIn} → {order.tokenOut}
                  </td>
                  <td className="py-3 px-4 text-sm text-title-text font-mono">
                    ${order.targetPrice.toFixed(4)}
                  </td>
                  <td className="py-3 px-4 text-sm text-title-text">
                    {order.amountIn.toFixed(4)}
                  </td>
                  <td className="py-3 px-4">
                    <span
                      className={classNames(
                        "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium",
                        order.status === "ACTIVE"
                          ? "text-blue-400 bg-blue-500/10"
                          : order.status === "FILLED"
                            ? "text-green-400 bg-green-500/10"
                            : order.status === "CANCELLED"
                              ? "text-muted-text bg-muted-text/10"
                              : "text-amber-400 bg-amber-500/10"
                      )}
                    >
                      {order.forceAfter && order.status === "ACTIVE" && (
                        <Clock className="w-3 h-3" />
                      )}
                      {order.status}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    {order.status === "ACTIVE" && (
                      <button
                        onClick={() => cancelMutation.mutate(order.id)}
                        className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="text-center py-12 text-muted-text">
                  No limit orders yet. Create one above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
