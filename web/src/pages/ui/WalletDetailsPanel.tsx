import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  CheckCheck,
  X,
  Loader2,
  AlertTriangle,
  Send,
} from "lucide-react";
import { apiFetch } from "../../lib/api";

export interface WalletRecord {
  id: number;
  address: string;
  name: string;
  balance: number;
  createdAt: string;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={copy}
      title="Copy address"
      className="text-muted-text hover:text-title-text transition-colors"
    >
      {copied ? <CheckCheck className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

export function WalletDetailsPanel({
  wallet,
  onClose,
}: {
  wallet: WalletRecord;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<"balances" | "transfer">("balances");
  const [transferAddress, setTransferAddress] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferToken, setTransferToken] = useState("STX");
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferSuccessTxId, setTransferSuccessTxId] = useState<string | null>(null);

  const { data: balances = [], isLoading: isBalancesLoading } = useQuery<
    Array<{ token: string; symbol: string; balance: number; usdValue: number }>
  >({
    queryKey: ["wallet-balances", wallet.id],
    queryFn: () => apiFetch(`/me/wallets/${wallet.id}/balances`),
    refetchInterval: 10000,
  });

  const transferMut = useMutation({
    mutationFn: (vars: { toAddress: string; amount: number; token: string }) =>
      apiFetch(`/me/wallets/${wallet.id}/transfer`, {
        method: "POST",
        body: JSON.stringify(vars),
      }) as Promise<{ ok: boolean; txId: string }>,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["wallet-balances", wallet.id] });
      qc.invalidateQueries({ queryKey: ["wallets"] });
      setTransferAddress("");
      setTransferAmount("");
      setTransferSuccessTxId(data.txId);
      setTransferError(null);
    },
    onError: (err: Error) => {
      setTransferError(err.message);
      setTransferSuccessTxId(null);
    },
  });

  const handleTransferSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!transferAddress.trim() || !transferAmount) return;
    setTransferSuccessTxId(null);
    setTransferError(null);
    transferMut.mutate({
      toAddress: transferAddress.trim(),
      amount: parseFloat(transferAmount),
      token: transferToken,
    });
  };

  return (
    <div className="bg-card-bg border border-card-border rounded-2xl p-6 flex flex-col gap-6 h-full min-h-[400px]">
      <div className="flex items-center justify-between border-b border-divider-color pb-4">
        <div>
          <h3 className="text-lg font-bold text-title-text">{wallet.name} Details</h3>
          <p className="text-xs font-mono text-muted-text mt-1 flex items-center gap-1.5 break-all">
            {wallet.address}
            <CopyButton text={wallet.address} />
          </p>
        </div>
        <button onClick={onClose} className="text-muted-text hover:text-title-text p-1 hover:bg-bg-hover rounded transition-colors">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex border-b border-divider-color">
        <button
          onClick={() => { setActiveTab("balances"); setTransferSuccessTxId(null); setTransferError(null); }}
          className={`flex-1 pb-2 text-sm font-semibold border-b-2 transition-colors ${activeTab === "balances"
              ? "border-brand-500 text-brand-400"
              : "border-transparent text-muted-text hover:text-title-text"
            }`}
        >
          Balances
        </button>
        <button
          onClick={() => { setActiveTab("transfer"); setTransferSuccessTxId(null); setTransferError(null); }}
          className={`flex-1 pb-2 text-sm font-semibold border-b-2 transition-colors ${activeTab === "transfer"
              ? "border-brand-500 text-brand-400"
              : "border-transparent text-muted-text hover:text-title-text"
            }`}
        >
          Transfer Assets
        </button>
      </div>

      {activeTab === "balances" && (
        <div className="flex-1 overflow-y-auto space-y-4">
          {isBalancesLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-text gap-2">
              <Loader2 className="w-5 h-5 animate-spin text-brand-400" />
              <span>Loading token balances...</span>
            </div>
          ) : balances.length === 0 ? (
            <div className="text-center py-12 text-muted-text text-sm">
              No balances found on chain for this address.
            </div>
          ) : (
            <div className="space-y-3">
              {balances.map((b) => (
                <div key={b.token} className="p-3.5 rounded-xl border border-divider-color bg-bg-hover flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-brand-500/10 flex items-center justify-center font-bold text-xs text-brand-400">
                      {b.symbol.slice(0, 3)}
                    </div>
                    <div>
                      <p className="font-semibold text-sm text-title-text">{b.symbol}</p>
                      <p className="text-xs text-muted-text/80 font-mono mt-0.5 truncate max-w-[180px]" title={b.token}>
                        {b.token === "STX" ? "Native STX Token" : b.token.split(".")[1] || b.token}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-title-text text-sm">
                      {b.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}
                    </p>
                    <p className="text-xs text-muted-text font-medium mt-0.5">
                      ${b.usdValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "transfer" && (
        <form onSubmit={handleTransferSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-muted-text block mb-1">Asset to Transfer</label>
            <select
              value={transferToken}
              onChange={(e) => setTransferToken(e.target.value)}
              className="w-full px-3 py-2 bg-input-bg border border-divider-color rounded-lg text-sm text-title-text focus:border-brand-500 focus:outline-none"
            >
              <option value="STX">STX (Native)</option>
              {balances
                .filter((b) => b.symbol !== "STX" && b.balance > 0)
                .map((b) => (
                  <option key={b.token} value={b.token}>
                    {b.symbol} ({b.balance.toFixed(4)} available)
                  </option>
                ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-muted-text block mb-1">Recipient Address</label>
            <input
              type="text"
              value={transferAddress}
              onChange={(e) => setTransferAddress(e.target.value)}
              placeholder="e.g. SP3FBR2AGK5H9QBDH3EEN6DF8..."
              className="w-full px-3 py-2 bg-input-bg border border-divider-color rounded-lg text-sm text-title-text placeholder:text-muted-text focus:border-brand-500 focus:outline-none font-mono"
              required
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-muted-text block mb-1">Amount</label>
            <input
              type="number"
              step="any"
              value={transferAmount}
              onChange={(e) => setTransferAmount(e.target.value)}
              placeholder="0.0"
              className="w-full px-3 py-2 bg-input-bg border border-divider-color rounded-lg text-sm text-title-text placeholder:text-muted-text focus:border-brand-500 focus:outline-none"
              required
            />
          </div>

          {transferError && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{transferError}</span>
            </div>
          )}

          {transferSuccessTxId && (
            <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-xs text-green-400 space-y-1">
              <p className="font-semibold">Transfer broadcasted successfully!</p>
              <p className="font-mono break-all opacity-80">Tx ID: {transferSuccessTxId}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={transferMut.isPending || !transferAddress.trim() || !transferAmount}
            className="w-full py-2.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-semibold text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 mt-2"
          >
            {transferMut.isPending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Broadcasting Transfer...
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                Send Transaction
              </>
            )}
          </button>
        </form>
      )}
    </div>
  );
}
