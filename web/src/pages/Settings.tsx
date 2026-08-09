import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, AlertTriangle, CheckCircle2, Zap, Share2, Trash2, Plus, ShieldCheck, AtSign, Loader2, Fuel, Info, Sliders } from "lucide-react";
import { apiFetch } from "../lib/api";
import { useChains } from "../hooks/useChains";

interface TradeSettings {
  context: string;
  slippageBps: number;
  maxPositionPct: number;
  dailyLossLimit: number;
  rebalanceThreshold: number;
  useGasless: boolean;
  gaslessFeeToken: string;
  /** Chains that override the account default. Absent = inherits. */
  chains?: { chainId: string; slippageBps: number | null }[];
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
                Pay Stacks transaction fees in SIP-010 tokens via the VelumX relayer instead of
                STX. Other chains use per-chain gas sponsorship, below.
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

        {/* Slippage overrides, per chain */}
        <ChainSlippageSection accountSlippageBps={form.slippageBps} />

        {/* Gas sponsorship, per chain */}
        <GasSponsorshipSection />

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

interface PendingVerification {
  code: string;
  platform: string;
  expiresAt: string;
  /** The exact text to post — a paraphrase that drops the mention is invisible to us. */
  postText: string;
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

interface GasSponsorshipChain {
  chainId: string;
  displayName: string;
  nativeSymbol: string;
  available: boolean;
  reason: string | null;
  enabled: boolean;
}

/**
 * Per-chain gas sponsorship.
 *
 * Every enabled chain is listed, including the ones that cannot sponsor —
 * with the reason, and the toggle disabled. Hiding them would leave a user
 * wondering why Celo has no switch; "this chain uses EOA custody, which pays
 * its own gas" is a better answer than an absent row.
 */
/**
 * Per-chain slippage overrides.
 *
 * Slippage is the setting that differs most by chain — a Stacks AMM and a
 * Solana aggregator are not the same trade at the same tolerance — so it is the
 * one the account default can be overridden for. Position and loss limits stay
 * account-wide on purpose: they bound total exposure, and per-chain copies
 * would let someone with three chains take three times the position they asked
 * to be limited to.
 *
 * A chain with no override inherits, and clearing one puts it back to
 * inheriting rather than pinning it at today's value.
 */
function ChainSlippageSection({ accountSlippageBps }: { accountSlippageBps: number }) {
  const queryClient = useQueryClient();
  const { chains, isLoading } = useChains();
  const { data: settings } = useQuery<TradeSettings>({
    queryKey: ["settings"],
    queryFn: () => apiFetch("/me/settings"),
  });

  const overrides = new Map(
    (settings?.chains ?? []).map((c) => [c.chainId, c.slippageBps])
  );

  const mutation = useMutation({
    mutationFn: ({ chainId, slippageBps }: { chainId: string; slippageBps: number | null }) =>
      apiFetch("/me/settings", {
        method: "PUT",
        body: JSON.stringify({ chainId, slippageBps }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  if (isLoading || chains.length <= 1) return null;

  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-5">
      <div className="flex items-start gap-3 mb-4">
        <Sliders className="w-5 h-5 text-brand-400 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-title-text">Slippage per chain</p>
          <p className="text-xs text-body-text/60 mt-1">
            Chains left on “Inherit” use your account default of {accountSlippageBps} bps.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {chains.map((chain) => {
          const override = overrides.get(chain.chainId) ?? null;
          return (
            <div
              key={chain.chainId}
              className="flex items-center justify-between gap-3 py-2 border-t border-divider-color first:border-t-0"
            >
              <div className="min-w-0">
                <p className="text-sm text-title-text">{chain.displayName}</p>
                <p className="text-xs text-body-text/60 font-mono truncate">{chain.chainId}</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <input
                  type="number"
                  min={10}
                  max={5000}
                  step={10}
                  value={override ?? ""}
                  placeholder={`${accountSlippageBps}`}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    mutation.mutate({
                      chainId: chain.chainId,
                      // Empty clears the override rather than storing 0, which
                      // would mean "accept no slippage" and fail every swap.
                      slippageBps: raw === "" ? null : Number(raw),
                    });
                  }}
                  className="w-24 px-2 py-1.5 bg-input-bg border border-divider-color rounded-lg text-sm text-title-text text-right focus:border-brand-500 focus:outline-none"
                />
                <span className="text-xs text-body-text/60 w-8">bps</span>
                <button
                  onClick={() => mutation.mutate({ chainId: chain.chainId, slippageBps: null })}
                  disabled={override === null}
                  className="text-xs text-body-text/60 hover:text-title-text disabled:opacity-30 transition-colors"
                >
                  Inherit
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GasSponsorshipSection() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ chains: GasSponsorshipChain[] }>({
    queryKey: ["gas-sponsorship"],
    queryFn: () => apiFetch("/me/gas-sponsorship"),
  });

  const toggle = useMutation({
    mutationFn: ({ chainId, enabled }: { chainId: string; enabled: boolean }) =>
      apiFetch("/me/gas-sponsorship", {
        method: "PUT",
        body: JSON.stringify({ chainId, enabled }),
      }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["gas-sponsorship"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const chains = data?.chains ?? [];
  const sponsorable = chains.filter((c) => c.available);

  return (
    <div className="bg-card-bg border border-card-border rounded-xl p-5 space-y-4">
      <div className="flex items-start gap-3">
        <Fuel className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" />
        <div>
          <h3 className="text-sm font-medium text-title-text">Gas Sponsorship</h3>
          <p className="text-sm text-body-text/70 mt-1">
            When on, transaction fees on a chain are paid by a paymaster rather than
            from your wallet&apos;s balance. Turn it off to pay your own gas in{" "}
            {sponsorable.length === 1 ? sponsorable[0]!.nativeSymbol : "the chain's native asset"}.
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-body-text/60">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading chains...
        </div>
      ) : chains.length === 0 ? (
        <p className="text-sm text-body-text/60">No chains are enabled on this deployment.</p>
      ) : (
        <div className="space-y-2">
          {chains.map((chain) => (
            <div
              key={chain.chainId}
              className="flex items-center justify-between gap-4 bg-input-bg border border-card-border rounded-lg px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-title-text truncate">
                  {chain.displayName}
                </p>
                <p className="text-xs text-body-text/60 font-mono truncate">{chain.chainId}</p>
                {!chain.available && chain.reason && (
                  <p className="text-xs text-body-text/50 mt-1 flex items-start gap-1">
                    <Info className="w-3 h-3 flex-shrink-0 mt-0.5" />
                    {chain.reason}
                  </p>
                )}
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={chain.enabled}
                aria-label={`Gas sponsorship on ${chain.displayName}`}
                disabled={!chain.available || toggle.isPending}
                onClick={() =>
                  toggle.mutate({ chainId: chain.chainId, enabled: !chain.enabled })
                }
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                  chain.enabled ? "bg-accent" : "bg-card-border"
                } ${!chain.available ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    chain.enabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-body-text/50">
        Turning sponsorship off on a wallet holding no native asset will make its
        transactions fail — fund it first.
      </p>
    </div>
  );
}

function SocialAccountsSection() {
  const queryClient = useQueryClient();
  const [showAddModal, setShowAddModal] = useState(false);
  const [newPlatform, setNewPlatform] = useState<"x" | "farcaster">("x");
  const [pending, setPending] = useState<PendingVerification | null>(null);

  const { data: accounts = [], isLoading } = useQuery<SocialAccountItem[]>({
    queryKey: ["social-accounts"],
    // Polled only while a challenge is open: the link appears when the mention
    // poller sees the post, which is seconds-to-a-minute after the user acts,
    // and there is nothing to refresh the page otherwise.
    refetchInterval: pending ? 5_000 : false,
    queryFn: () => apiFetch("/me/social-accounts"),
  });

  const startMutation = useMutation({
    mutationFn: (platform: "x" | "farcaster") =>
      apiFetch<PendingVerification>("/me/social-accounts/verify", {
        method: "POST",
        body: JSON.stringify({ platform }),
      }),
    onSuccess: (data) => setPending(data),
  });

  // The challenge closes itself once the account shows up — the user's
  // attention is on their other app at that moment, not on this modal.
  useEffect(() => {
    if (!pending) return;
    if (accounts.some((a) => a.platform === pending.platform && a.verifiedAt)) {
      setPending(null);
      setShowAddModal(false);
    }
  }, [accounts, pending]);

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

      {/* Verification modal.
        *
        * No field for an account id. The previous form asked for one and wrote
        * it straight to the row, so "verified" recorded only that the user had
        * typed their own identifier — anyone could claim any account's. The id
        * is now read off the post the account actually publishes.
        */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="glass-card max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-title-text">Link Social Account</h3>

            {!pending ? (
              <>
                <div>
                  <label className="block text-muted-text text-xs mb-1">Platform</label>
                  <div className="flex gap-2">
                    {(["x", "farcaster"] as const).map((platform) => (
                      <button
                        key={platform}
                        type="button"
                        onClick={() => setNewPlatform(platform)}
                        className={`flex-1 py-2 rounded-lg text-xs font-semibold capitalize transition-colors ${
                          newPlatform === platform
                            ? "bg-brand-500 text-white"
                            : "bg-input-bg text-muted-text"
                        }`}
                      >
                        {platform === "x" ? "X (Twitter)" : "Farcaster"}
                      </button>
                    ))}
                  </div>
                </div>

                <p className="text-xs text-muted-text">
                  We&apos;ll give you a one-time code to post. Reading it off your own
                  post is what proves the account is yours — nothing you type here
                  could.
                </p>

                {startMutation.isError && (
                  <p className="text-xs text-red-400">{(startMutation.error as Error).message}</p>
                )}

                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowAddModal(false)}
                    className="flex-1 py-2 bg-input-bg text-body-text rounded-lg font-semibold text-xs"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={startMutation.isPending}
                    onClick={() => startMutation.mutate(newPlatform)}
                    className="flex-1 py-2 bg-brand-500 text-white rounded-lg font-semibold text-xs hover:bg-brand-600 disabled:opacity-50"
                  >
                    {startMutation.isPending ? "Starting..." : "Get my code"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <ol className="text-xs text-body-text space-y-2 list-decimal list-inside">
                  <li>Post this on {pending.platform === "x" ? "X" : "Farcaster"}:</li>
                </ol>

                <div className="bg-input-bg border border-card-border rounded-lg p-3">
                  <p className="text-xs font-mono text-title-text break-words">
                    {pending.postText}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(pending.postText)}
                  className="w-full py-2 bg-input-bg text-body-text rounded-lg text-xs font-semibold"
                >
                  Copy text
                </button>

                <p className="text-xs text-muted-text">
                  Post it exactly as written — the mention is how we see it at all.
                  We check every minute or so; this page updates itself. The code
                  expires {new Date(pending.expiresAt).toLocaleTimeString()}.
                </p>

                <div className="flex items-center gap-2 text-xs text-muted-text">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Waiting for your post...
                </div>

                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="w-full py-2 bg-input-bg text-body-text rounded-lg font-semibold text-xs"
                >
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

