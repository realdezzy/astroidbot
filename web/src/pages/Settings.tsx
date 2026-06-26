import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, AlertTriangle, CheckCircle2, Zap } from "lucide-react";
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
