import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, AlertTriangle, CheckCircle2, Zap, Share2, Trash2, Plus, ShieldCheck, AtSign, Loader2 } from "lucide-react";
import { apiFetch } from "../lib/api";

interface TradeSettings {
  context: string;
  chain: string;
  slippageBps: number;
  maxPositionPct: number;
  dailyLossLimit: number;
  rebalanceThreshold: number;
  useGasless: boolean;
  gaslessFeeToken: string;
}

interface GaslessToken {
  symbol: string;
  contractId: string;
}

interface GaslessInfo {
  enabled: boolean;
  tokens: GaslessToken[];
}

export function Settings() {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);

  const { data: settings } = useQuery<TradeSettings>({
    queryKey: ["settings"],
    queryFn: () => apiFetch("/me/settings"),
  });

  const { data: gaslessInfo } = useQuery<GaslessInfo>({
    queryKey: ["gasless-supported"],
    queryFn: () => apiFetch("/tokens/gasless-supported"),
  });

  const mutation = useMutation({
    mutationFn: (data: Partial<TradeSettings>) =>
      apiFetch("/me/settings", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  const [form, setForm] = useState({
    slippageBps: 100,
    maxPositionPct: 25,
    dailyLossLimit: 5,
    rebalanceThreshold: 2,
    useGasless: false,
    gaslessFeeToken: "USDC",
  });

  useEffect(() => {
    if (settings) {
      setForm({
        slippageBps: settings.slippageBps,
        maxPositionPct: settings.maxPositionPct,
        dailyLossLimit: settings.dailyLossLimit,
        rebalanceThreshold: settings.rebalanceThreshold,
        useGasless: settings.useGasless ?? false,
        gaslessFeeToken: settings.gaslessFeeToken ?? "USDC",
      });
    }
  }, [settings]);

  const handleSliderChange = (field: keyof typeof form, value: number) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-bold text-title-text">Trade Settings</h2>
          <p className="text-muted-text mt-1">
            Configure your trading parameters and risk limits
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="flex items-center gap-1.5 text-sm text-green-400">
              <CheckCircle2 className="w-4 h-4" />
              Saved
            </span>
          )}
          <button
            id="settings-save-btn"
            onClick={() => mutation.mutate(form)}
            disabled={mutation.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {mutation.isPending ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>

      <div className="space-y-6 max-w-2xl">
        <SettingCard
          label="Max Slippage (bps)"
          description="Maximum acceptable price slippage per trade. 100 bps = 1%"
          value={form.slippageBps}
          min={10}
          max={1000}
          step={10}
          unit="bps"
          onChange={(v) => handleSliderChange("slippageBps", v)}
        />

        <SettingCard
          label="Max Position Size"
          description="Maximum percentage of portfolio allocated to a single asset"
          value={form.maxPositionPct}
          min={1}
          max={100}
          step={1}
          unit="%"
          onChange={(v) => handleSliderChange("maxPositionPct", v)}
        />

        <SettingCard
          label="Daily Loss Limit"
          description="Bot stops trading if daily PnL drops below this threshold"
          value={form.dailyLossLimit}
          min={0.5}
          max={25}
          step={0.5}
          unit="%"
          onChange={(v) => handleSliderChange("dailyLossLimit", v)}
        />

        <SettingCard
          label="Rebalance Threshold"
          description="Minimum portfolio weight deviation to trigger a rebalance trade"
          value={form.rebalanceThreshold}
          min={0.5}
          max={10}
          step={0.5}
          unit="%"
          onChange={(v) => handleSliderChange("rebalanceThreshold", v)}
        />

        {/* Gasless Transactions (VelumX) */}
        <div className="glass-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-violet-400" />
                <label className="text-sm font-medium text-title-text">
                  Gasless Transactions
                </label>
                {!gaslessInfo?.enabled && (
                  <span className="text-xs bg-input-bg text-muted-text/80 px-2 py-0.5 rounded-full border border-divider-color">
                    Not configured
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-text mt-0.5">
                Pay transaction fees in SIP-010 tokens via the VelumX relayer instead of STX
              </p>
            </div>
            <button
              id="gasless-toggle"
              role="switch"
              aria-checked={form.useGasless}
              disabled={!gaslessInfo?.enabled}
              onClick={() =>
                setForm((prev) => ({ ...prev, useGasless: !prev.useGasless }))
              }
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                form.useGasless ? "bg-violet-500" : "bg-gray-700"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  form.useGasless ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {form.useGasless && gaslessInfo?.enabled && (
            <div>
              <label className="text-xs text-muted-text mb-1.5 block">
                Fee Token
              </label>
              <div className="flex gap-2 flex-wrap">
                {gaslessInfo.tokens.map((token) => (
                  <button
                    key={token.symbol}
                    id={`fee-token-${token.symbol}`}
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        gaslessFeeToken: token.symbol,
                      }))
                    }
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                      form.gaslessFeeToken === token.symbol
                        ? "border-violet-500 bg-violet-500/10 text-violet-300"
                        : "border-divider-color bg-input-bg text-muted-text hover:border-brand-500"
                    }`}
                  >
                    {token.symbol}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-text/60 mt-2">
                The selected token will be deducted from your wallet balance to cover relayer fees.
              </p>
            </div>
          )}
        </div>

        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-400">Risk Warning</p>
            <p className="text-sm text-amber-400/70 mt-1">
              Reducing safety parameters increases exposure to market volatility
              and potential losses. Always test with small amounts first.
            </p>
          </div>
        </div>

        {/* Social Trading Accounts Section */}
        <SocialAccountsSection />
      </div>
    </div>
  );
}

function SettingCard({
  label,
  description,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <label className="text-sm font-medium text-title-text">{label}</label>
          <p className="text-xs text-muted-text mt-0.5">{description}</p>
        </div>
        <span className="text-lg font-bold text-brand-400 tabular-nums">
          {value}
          <span className="text-sm ml-0.5 text-muted-text">{unit}</span>
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-2 bg-input-bg rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand-500 [&::-webkit-slider-thumb]:cursor-pointer"
      />
      <div className="flex justify-between mt-1.5 text-xs text-muted-text/60">
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  );
}

interface SocialAccountItem {
  id: number;
  platform: "x" | "farcaster";
  handle: string;
  platformUserId: string;
  perTradeLimitUsd: number;
  dailyLimitUsd: number;
  autoExecute: boolean;
  enabled: boolean;
  verifiedAt: string | null;
}

function SocialAccountsSection() {
  const queryClient = useQueryClient();
  const [showAddModal, setShowAddModal] = useState(false);
  const [newPlatform, setNewPlatform] = useState<"x" | "farcaster">("x");
  const [newHandle, setNewHandle] = useState("");
  const [newPlatformUserId, setNewPlatformUserId] = useState("");
  const [newPerTrade, setNewPerTrade] = useState(100);
  const [newDaily, setNewDaily] = useState(500);
  const [newAutoExecute, setNewAutoExecute] = useState(false);

  const { data: accounts = [], isLoading } = useQuery<SocialAccountItem[]>({
    queryKey: ["social-accounts"],
    queryFn: () => apiFetch("/me/social-accounts"),
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiFetch("/me/social-accounts", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["social-accounts"] });
      setShowAddModal(false);
      setNewHandle("");
      setNewPlatformUserId("");
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<SocialAccountItem> }) =>
      apiFetch(`/me/social-accounts/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["social-accounts"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/me/social-accounts/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["social-accounts"] }),
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newHandle || !newPlatformUserId) return;
    createMutation.mutate({
      platform: newPlatform,
      handle: newHandle.replace(/^@/, ""),
      platformUserId: newPlatformUserId,
      perTradeLimitUsd: newPerTrade,
      dailyLimitUsd: newDaily,
      autoExecute: newAutoExecute,
    });
  };

  return (
    <div className="glass-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Share2 className="w-4 h-4 text-brand-400" />
            <h3 className="text-sm font-medium text-title-text">Social Accounts</h3>
          </div>
          <p className="text-xs text-muted-text mt-0.5">
            Link your X (Twitter) or Farcaster accounts to trade by mentioning @AstroidBot
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-xs font-semibold transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> Link Account
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-text py-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading social accounts...
        </div>
      ) : accounts.length === 0 ? (
        <div className="p-4 rounded-xl border border-divider-color bg-input-bg/30 text-center text-xs text-muted-text">
          No social accounts linked yet. Click &quot;Link Account&quot; to connect your X or Farcaster profile.
        </div>
      ) : (
        <div className="space-y-3">
          {accounts.map((acc) => (
            <div
              key={acc.id}
              className="p-4 rounded-xl border border-divider-color bg-input-bg/40 space-y-3"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 bg-brand-500/10 border border-brand-500/20 text-brand-400 font-semibold uppercase text-[10px] rounded">
                    {acc.platform}
                  </span>
                  <span className="text-sm font-bold text-title-text flex items-center gap-1">
                    <AtSign className="w-3.5 h-3.5 text-muted-text" />
                    {acc.handle}
                  </span>
                  <span className="text-xs text-muted-text font-mono">
                    ({acc.platform === "farcaster" ? `FID: ${acc.platformUserId}` : `ID: ${acc.platformUserId}`})
                  </span>
                  {acc.verifiedAt && (
                    <span className="flex items-center gap-1 text-[10px] text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full border border-green-500/20">
                      <ShieldCheck className="w-3 h-3" /> Verified
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-muted-text cursor-pointer">
                    <span>Active</span>
                    <input
                      type="checkbox"
                      checked={acc.enabled}
                      onChange={(e) =>
                        updateMutation.mutate({
                          id: acc.id,
                          data: { enabled: e.target.checked },
                        })
                      }
                      className="rounded bg-input-bg border-divider-color text-brand-500 focus:ring-0"
                    />
                  </label>
                  <button
                    onClick={() => deleteMutation.mutate(acc.id)}
                    className="p-1 text-muted-text hover:text-red-400 transition-colors"
                    title="Unlink Account"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-divider-color/40 text-xs">
                <div>
                  <label className="text-muted-text block mb-1">Per-Trade Limit ($)</label>
                  <input
                    type="number"
                    value={acc.perTradeLimitUsd}
                    onChange={(e) =>
                      updateMutation.mutate({
                        id: acc.id,
                        data: { perTradeLimitUsd: parseFloat(e.target.value) || 0 },
                      })
                    }
                    className="w-full bg-input-bg border border-divider-color rounded-lg px-2.5 py-1 text-title-text focus:outline-none focus:border-brand-500"
                  />
                </div>
                <div>
                  <label className="text-muted-text block mb-1">Daily Limit ($)</label>
                  <input
                    type="number"
                    value={acc.dailyLimitUsd}
                    onChange={(e) =>
                      updateMutation.mutate({
                        id: acc.id,
                        data: { dailyLimitUsd: parseFloat(e.target.value) || 0 },
                      })
                    }
                    className="w-full bg-input-bg border border-divider-color rounded-lg px-2.5 py-1 text-title-text focus:outline-none focus:border-brand-500"
                  />
                </div>
                <div>
                  <label className="text-muted-text block mb-1">Execution Mode</label>
                  <button
                    onClick={() =>
                      updateMutation.mutate({
                        id: acc.id,
                        data: { autoExecute: !acc.autoExecute },
                      })
                    }
                    className={`w-full py-1 px-2.5 rounded-lg border font-medium text-xs transition-colors ${
                      acc.autoExecute
                        ? "bg-violet-500/10 border-violet-500/30 text-violet-300"
                        : "bg-input-bg border-divider-color text-muted-text"
                    }`}
                  >
                    {acc.autoExecute ? "⚡ Auto-Execute" : "🔗 Require Confirmation Link"}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Account Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="glass-card max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-title-text">Link Social Account</h3>
            <form onSubmit={handleCreate} className="space-y-3 text-xs">
              <div>
                <label className="block text-muted-text mb-1">Platform</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setNewPlatform("x")}
                    className={`flex-1 py-2 rounded-lg font-semibold border ${
                      newPlatform === "x"
                        ? "bg-brand-500 text-white border-brand-500"
                        : "bg-input-bg text-muted-text border-divider-color"
                    }`}
                  >
                    X (Twitter)
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewPlatform("farcaster")}
                    className={`flex-1 py-2 rounded-lg font-semibold border ${
                      newPlatform === "farcaster"
                        ? "bg-brand-500 text-white border-brand-500"
                        : "bg-input-bg text-muted-text border-divider-color"
                    }`}
                  >
                    Farcaster
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-muted-text mb-1">Handle / Username</label>
                <input
                  type="text"
                  placeholder="@username"
                  value={newHandle}
                  onChange={(e) => setNewHandle(e.target.value)}
                  required
                  className="w-full bg-input-bg border border-divider-color rounded-lg px-3 py-2 text-title-text focus:outline-none focus:border-brand-500"
                />
              </div>

              <div>
                <label className="block text-muted-text mb-1">
                  {newPlatform === "farcaster" ? "Numeric FID (Immutable)" : "X User ID (Numeric/Immutable)"}
                </label>
                <input
                  type="text"
                  placeholder={newPlatform === "farcaster" ? "e.g. 12345" : "e.g. 987654321"}
                  value={newPlatformUserId}
                  onChange={(e) => setNewPlatformUserId(e.target.value)}
                  required
                  className="w-full bg-input-bg border border-divider-color rounded-lg px-3 py-2 text-title-text focus:outline-none focus:border-brand-500"
                />
                <p className="text-[10px] text-muted-text/70 mt-0.5">
                  Authorization keys strictly on immutable IDs to prevent handle impersonation.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-muted-text mb-1">Per-Trade Limit ($)</label>
                  <input
                    type="number"
                    value={newPerTrade}
                    onChange={(e) => setNewPerTrade(parseFloat(e.target.value) || 0)}
                    className="w-full bg-input-bg border border-divider-color rounded-lg px-3 py-1.5 text-title-text"
                  />
                </div>
                <div>
                  <label className="block text-muted-text mb-1">Daily Limit ($)</label>
                  <input
                    type="number"
                    value={newDaily}
                    onChange={(e) => setNewDaily(parseFloat(e.target.value) || 0)}
                    className="w-full bg-input-bg border border-divider-color rounded-lg px-3 py-1.5 text-title-text"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="modal-auto-execute"
                  checked={newAutoExecute}
                  onChange={(e) => setNewAutoExecute(e.target.checked)}
                  className="rounded bg-input-bg border-divider-color text-brand-500"
                />
                <label htmlFor="modal-auto-execute" className="text-muted-text cursor-pointer">
                  Auto-execute trades without requiring link confirmation
                </label>
              </div>

              <div className="flex gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 py-2 bg-input-bg text-muted-text rounded-lg font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="flex-1 py-2 bg-brand-500 text-white rounded-lg font-semibold hover:bg-brand-600 disabled:opacity-50"
                >
                  {createMutation.isPending ? "Linking..." : "Link Account"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

