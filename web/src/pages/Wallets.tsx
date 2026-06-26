import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Wallet,
  Plus,
  Download,
  Trash2,
  Eye,
  EyeOff,
  Copy,
  CheckCheck,
  AlertTriangle,
  X,
  KeyRound,
  Loader2,
  Send,
  Coins,
  ArrowRight,
} from "lucide-react";
import { WalletDetailsPanel } from "./ui/WalletDetailsPanel";
import { apiFetch } from "../lib/api";
import { classNames } from "../lib/utils";




interface WalletRecord {
  id: number;
  address: string;
  name: string;
  balance: number;
  createdAt: string;
}

function shortenAddr(addr: string) {
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
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

// ─── Import Modal ────────────────────────────────────────────────────────────

function ImportModal({ onClose }: { onClose: () => void }) {
  const [privateKey, setPrivateKey] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const importMut = useMutation({
    mutationFn: () =>
      apiFetch("/me/wallets/import", {
        method: "POST",
        body: JSON.stringify({ privateKey: privateKey.trim(), name: name.trim() || undefined }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wallets"] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card-bg border border-card-border rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold text-title-text flex items-center gap-2">
            <Download className="w-5 h-5 text-brand-400" /> Import Wallet
          </h3>
          <button onClick={onClose} className="text-muted-text hover:text-title-text transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-300">
            Never share your private key. It is encrypted and stored securely on our servers. Use a dedicated trading wallet, not your main wallet.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-text block mb-1">Wallet Name (optional)</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Trading Wallet"
              className="w-full px-3 py-2 bg-input-bg border border-divider-color rounded-lg text-sm text-title-text placeholder:text-muted-text focus:border-brand-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-text block mb-1">Stacks Private Key</label>
            <textarea
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="64-character hex private key..."
              rows={3}
              className="w-full px-3 py-2 bg-input-bg border border-divider-color rounded-lg text-sm text-title-text placeholder:text-muted-text focus:border-brand-500 focus:outline-none font-mono resize-none"
            />
          </div>
          <button
            onClick={() => importMut.mutate()}
            disabled={importMut.isPending || !privateKey.trim()}
            className="w-full py-2.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {importMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Import Wallet
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Reveal Key Modal ─────────────────────────────────────────────────────────

function RevealKeyModal({ wallet, onClose }: { wallet: WalletRecord; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const revealMut = useMutation({
    mutationFn: () =>
      apiFetch(`/me/wallets/${wallet.id}/reveal`, {
        method: "POST",
        body: JSON.stringify({ password }),
      }) as Promise<{ privateKey: string }>,
    onSuccess: (data: { privateKey: string }) => {
      setPrivateKey(data.privateKey);
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const copy = () => {
    if (!privateKey) return;
    navigator.clipboard.writeText(privateKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card-bg border border-card-border rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold text-title-text flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-amber-400" /> Reveal Private Key
          </h3>
          <button onClick={onClose} className="text-muted-text hover:text-title-text transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
          <p className="text-xs text-red-300">
            Never share this key with anyone. Anyone with access to it has full control of this wallet.
          </p>
        </div>

        <p className="text-xs text-muted-text mb-4">
          Revealing key for: <span className="font-mono text-title-text">{wallet.name}</span>
          <br /><span className="font-mono text-muted-text/70">{shortenAddr(wallet.address)}</span>
        </p>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">{error}</div>
        )}

        {!privateKey ? (
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-text block mb-1">Confirm your password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your account password"
                className="w-full px-3 py-2 bg-input-bg border border-divider-color rounded-lg text-sm text-title-text placeholder:text-muted-text focus:border-brand-500 focus:outline-none"
                onKeyDown={(e) => e.key === "Enter" && revealMut.mutate()}
              />
            </div>
            <button
              onClick={() => revealMut.mutate()}
              disabled={revealMut.isPending || !password}
              className="w-full py-2.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {revealMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
              Reveal Key
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <div className="bg-input-bg border border-divider-color rounded-lg p-3 font-mono text-xs text-title-text break-all select-all">
                {shown ? privateKey : "•".repeat(privateKey.length)}
              </div>
              <div className="absolute top-2 right-2 flex gap-1.5">
                <button onClick={() => setShown(!shown)} className="text-muted-text hover:text-title-text transition-colors">
                  {shown ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                <button onClick={copy} className="text-muted-text hover:text-title-text transition-colors">
                  {copied ? <CheckCheck className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-full py-2 bg-input-bg hover:bg-bg-hover text-muted-text rounded-lg text-sm transition-colors"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Create Modal ────────────────────────────────────────────────────────────

function CreateModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const generateMut = useMutation({
    mutationFn: () =>
      apiFetch("/me/wallets/generate", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() || undefined }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wallets"] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card-bg border border-card-border rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold text-title-text flex items-center gap-2">
            <Plus className="w-5 h-5 text-brand-400" /> Create Wallet
          </h3>
          <button onClick={onClose} className="text-muted-text hover:text-title-text transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-text block mb-1">Wallet Name (optional)</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Stacks Wallet"
              className="w-full px-3 py-2 bg-input-bg border border-divider-color rounded-lg text-sm text-title-text placeholder:text-muted-text focus:border-brand-500 focus:outline-none"
              onKeyDown={(e) => e.key === "Enter" && generateMut.mutate()}
              autoFocus
            />
          </div>
          <button
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending}
            className="w-full py-2.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {generateMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Create Wallet
          </button>
        </div>
      </div>
    </div>
  );
}

// WalletDetailsPanel is imported from ui/WalletDetailsPanel

// ─── Main Page ────────────────────────────────────────────────────────────────


export function Wallets() {
  const qc = useQueryClient();
  const [showImport, setShowImport] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [revealWallet, setRevealWallet] = useState<WalletRecord | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [selectedWalletId, setSelectedWalletId] = useState<number | null>(null);

  const { data: wallets = [], isLoading } = useQuery<WalletRecord[]>({
    queryKey: ["wallets"],
    queryFn: () => apiFetch("/me/wallets"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/me/wallets/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wallets"] });
      setDeleteError(null);
      if (selectedWalletId) {
        setSelectedWalletId(null);
      }
    },
    onError: (err: Error) => setDeleteError(err.message),
  });

  const selectedWallet = wallets.find((w) => w.id === selectedWalletId);

  return (
    <div>
      {showImport && <ImportModal onClose={() => setShowImport(false)} />}
      {showCreate && <CreateModal onClose={() => setShowCreate(false)} />}
      {revealWallet && <RevealKeyModal wallet={revealWallet} onClose={() => setRevealWallet(null)} />}

      <div className="mb-8 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-title-text">Wallets</h2>
          <p className="text-muted-text mt-1">Manage your Stacks trading wallets</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-2 px-4 py-2 bg-input-bg hover:bg-bg-hover border border-divider-color text-muted-text rounded-lg text-sm font-medium transition-colors"
          >
            <Download className="w-4 h-4" /> Import
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Wallet
          </button>
        </div>
      </div>

      {deleteError && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {deleteError}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-text">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading wallets...</span>
        </div>
      ) : wallets.length === 0 ? (
        <div className="text-center py-20 bg-card-bg border border-card-border rounded-2xl">
          <Wallet className="w-12 h-12 text-muted-text/50 mx-auto mb-4" />
          <p className="text-muted-text font-medium">No wallets yet</p>
          <p className="text-muted-text text-sm mt-1">Generate a new wallet or import an existing one</p>
        </div>
      ) : (
        <div className="flex flex-col lg:flex-row gap-6">
          <div className={classNames(
            "w-full flex flex-col gap-4 transition-all duration-300",
            selectedWallet ? "lg:w-1/2" : "lg:w-full grid grid-cols-1 md:grid-cols-2"
          )}>
            {wallets.map((w) => (
              <div
                key={w.id}
                onClick={() => setSelectedWalletId(selectedWalletId === w.id ? null : w.id)}
                className={classNames(
                  "bg-card-bg border rounded-2xl p-5 flex flex-col gap-4 hover:border-divider-color transition-all cursor-pointer select-none",
                  selectedWalletId === w.id
                    ? "border-brand-500 ring-1 ring-brand-500/20"
                    : "border-card-border"
                )}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-brand-500/15 flex items-center justify-center">
                      <Wallet className="w-5 h-5 text-brand-400" />
                    </div>
                    <div>
                      <p className="font-semibold text-title-text">{w.name}</p>
                      <p className="text-xs text-muted-text mt-0.5">
                        Created {new Date(w.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setRevealWallet(w);
                      }}
                      title="Reveal private key"
                      className="p-1.5 text-muted-text hover:text-amber-400 hover:bg-amber-400/10 rounded-lg transition-colors"
                    >
                      <KeyRound className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteError(null);
                        deleteMut.mutate(w.id);
                      }}
                      title="Delete wallet"
                      disabled={deleteMut.isPending}
                      className="p-1.5 text-muted-text hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors disabled:opacity-40"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="bg-input-bg/60 rounded-lg px-3 py-2 flex items-center justify-between">
                  <span className="font-mono text-xs text-title-text">{shortenAddr(w.address)}</span>
                  <CopyButton text={w.address} />
                </div>

                <div className="flex items-center justify-between border-t border-divider-color pt-3">
                  <span className="text-xs text-muted-text">Balance</span>
                  <span className="text-sm font-semibold text-title-text">
                    {w.balance.toFixed(4)} <span className="text-muted-text font-normal">STX</span>
                  </span>
                </div>
              </div>
            ))}
          </div>

          {selectedWallet && (
            <div className="w-full lg:w-1/2">
              <WalletDetailsPanel
                wallet={selectedWallet}
                onClose={() => setSelectedWalletId(null)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

