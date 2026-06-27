import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Trash2, ToggleLeft, ToggleRight, Play, Bot, ChevronDown,
  Loader2, Sparkles, Gauge, Grid3X3, Clock, Crosshair, Copy, Info,
  TrendingUp, RefreshCw, Timer, ShieldAlert, RotateCw, ArrowUpRight,
} from "lucide-react";
import { apiFetch } from "../lib/api";
import { formatDate, classNames } from "../lib/utils";
import { MultiWalletSelect } from "../components/MultiWalletSelect";
import { StrategyDetailModal } from "../components/StrategyDetailModal";
import { ChatInput } from "../components/ChatInput";
import { STRATEGY_REGISTRY, STRATEGY_DEFAULTS } from "@shared/strategies";
import type { StrategyType, AiMode } from "@shared/types";

const ICON_MAP: Record<string, React.FC<{ className?: string }>> = {
  portfolio_rebalance: Gauge,
  grid: Grid3X3,
  dca: Clock,
  sniper: Crosshair,
  copy: Copy,
  momentum: TrendingUp,
  mean_reversion: RefreshCw,
  twap: Timer,
  stop_loss_tp: ShieldAlert,
  rotational: RotateCw,
  breakout: ArrowUpRight,
};

interface AgentStrategy {
  id: number;
  agentId: number | null;
  type: string;
  isActive: boolean;
}

interface Agent {
  id: number;
  name: string;
  context: string;
  aiMode: AiMode;
  config: Record<string, unknown>;
  state: Record<string, unknown>;
  model: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  strategies: AgentStrategy[];
}

interface Strategy {
  id: number;
  agentId: number | null;
  type: string;
  config: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
}

// ───────────────────────────── Strategy sub-list for an agent ─────────────────────────────
// ───────────────────────────── Strategy sub-list for an agent ─────────────────────────────
function AgentStrategies({ agentId, wallets }: {
  agentId: number;
  wallets: { id: number; name: string; address: string; balance: number }[];
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<StrategyType>("portfolio_rebalance");
  const [config, setConfig] = useState<Record<string, unknown>>(STRATEGY_DEFAULTS.portfolio_rebalance);
  const [walletIds, setWalletIds] = useState<number[]>([]);
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data } = useQuery<{ strategies: Strategy[] }>({
    queryKey: ["strategies", agentId],
    queryFn: () => apiFetch(`/me/strategies?agentId=${agentId}`),
  });

  const createMutation = useMutation({
    mutationFn: (body: { agentId: number; type: string; config: Record<string, unknown>; walletIds: number[] }) =>
      apiFetch("/me/strategies", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["strategies", agentId] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      setAdding(false);
      setWalletIds([]);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      apiFetch(`/me/strategies/${id}`, { method: "PUT", body: JSON.stringify({ isActive }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["strategies", agentId] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/me/strategies/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["strategies", agentId] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  const strategies = data?.strategies ?? [];

  const handleCreate = () => {
    const parsed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config)) {
      const num = Number(v);
      parsed[k] = isNaN(num) ? v : num;
    }
    createMutation.mutate({ agentId, type, config: parsed, walletIds });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-muted-text uppercase tracking-wide">Strategies</h4>
        <button
          onClick={() => setAdding(!adding)}
          className="flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 transition-colors"
        >
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>

      {strategies.length === 0 && !adding && (
        <p className="text-xs text-muted-text/80">No strategies yet. Add one to give this agent something to execute.</p>
      )}

      {strategies.map((s) => {
        const info = STRATEGY_REGISTRY.find((x) => x.type === s.type) ?? STRATEGY_REGISTRY[0]!;
        const Icon = ICON_MAP[s.type] ?? Gauge;
        return (
          <div key={s.id} className={classNames("flex items-center gap-3 p-3 bg-input-bg/40 rounded-lg", !s.isActive && "opacity-50")}>
            <Icon className="w-4 h-4 text-brand-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-title-text">{info.label}</p>
              <p className="text-[10px] text-muted-text truncate">
                {Object.entries(s.config).filter(([k]) => k !== "walletIds").map(([k, v]) => `${k}: ${v}`).join(" · ")}
              </p>
            </div>
            <button onClick={() => setDetailId(s.id)} className="p-1 rounded hover:bg-bg-hover text-brand-400" title="Details">
              <Info className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => toggleMutation.mutate({ id: s.id, isActive: !s.isActive })} className="p-1 rounded hover:bg-bg-hover">
              {s.isActive ? <ToggleRight className="w-4 h-4 text-green-400" /> : <ToggleLeft className="w-4 h-4 text-muted-text" />}
            </button>
            <button onClick={() => deleteMutation.mutate(s.id)} className="p-1 rounded hover:bg-bg-hover text-red-400">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}

      {adding && (
        <div className="bg-input-bg/40 border border-divider-color rounded-lg p-3 space-y-3">
          <div>
            <label className="block text-[10px] text-muted-text mb-1.5">Strategy Type</label>
            <div className="grid grid-cols-3 gap-1.5">
              {STRATEGY_REGISTRY.map((s) => {
                const Icon = ICON_MAP[s.type] ?? Gauge;
                return (
                  <button
                    key={s.type}
                    onClick={() => { setType(s.type as StrategyType); setConfig({ ...s.defaults }); }}
                    className={classNames(
                      "flex items-center gap-1.5 p-2 rounded border text-left transition-colors",
                      type === s.type ? "bg-brand-500/10 border-brand-500/30 text-brand-400" : "bg-input-bg border-divider-color text-muted-text"
                    )}
                  >
                    <Icon className="w-3 h-3" />
                    <span className="text-[10px] font-medium">{s.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            {(STRATEGY_REGISTRY.find((x) => x.type === type)?.fields ?? []).map((f) => (
              <div key={f.key}>
                <label className="block text-[10px] text-muted-text mb-0.5">{f.label}</label>
                <input
                  type={f.type} step={f.step}
                  value={String(config[f.key] ?? "")}
                  onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
                  placeholder={f.placeholder}
                  className="w-full px-2.5 py-1.5 bg-input-bg border border-divider-color rounded text-xs text-title-text placeholder-muted-text/50 focus:border-brand-500 focus:outline-none"
                />
              </div>
            ))}
          </div>

          {wallets.length > 0 && (
            <div>
              <label className="block text-[10px] text-muted-text mb-1.5">Wallets</label>
              <MultiWalletSelect wallets={wallets} selectedIds={walletIds} onChange={setWalletIds} />
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={createMutation.isPending || walletIds.length === 0}
              className="flex-1 py-1.5 bg-brand-500 hover:bg-brand-600 text-white rounded text-xs font-medium disabled:opacity-50"
            >
              {createMutation.isPending ? "Adding..." : "Add Strategy"}
            </button>
            <button onClick={() => setAdding(false)} className="px-3 py-1.5 bg-input-bg hover:bg-bg-hover text-muted-text rounded text-xs">
              Cancel
            </button>
          </div>
        </div>
      )}

      {detailId !== null && (
        <StrategyDetailModal strategyId={detailId} onClose={() => setDetailId(null)} />
      )}
    </div>
  );
}

// ───────────────────────────── Main Agents page ─────────────────────────────
export function Agents() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [aiMode, setAiMode] = useState<AiMode>("off");
  const [maxPositionPct, setMaxPositionPct] = useState("25");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [runMsg, setRunMsg] = useState<Record<number, string>>({});

  const { data } = useQuery<{ agents: Agent[] }>({
    queryKey: ["agents"],
    queryFn: () => apiFetch("/me/agents"),
  });

  const { data: walletsData } = useQuery<{ id: number; name: string; address: string; balance: number }[]>({
    queryKey: ["wallets"],
    queryFn: () => apiFetch("/me/wallets"),
  });

  const wallets = walletsData ?? [];

  const createMutation = useMutation({
    mutationFn: (data: { name: string; aiMode: AiMode; config: Record<string, unknown> }) =>
      apiFetch("/me/agents", { method: "POST", body: JSON.stringify({ context: "custom", ...data }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      setShowForm(false); setName(""); setAiMode("off");
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      apiFetch(`/me/agents/${id}`, { method: "PUT", body: JSON.stringify({ isActive }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });

  const aiModeMutation = useMutation({
    mutationFn: ({ id, aiMode }: { id: number; aiMode: AiMode }) =>
      apiFetch(`/me/agents/${id}`, { method: "PUT", body: JSON.stringify({ aiMode }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/me/agents/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });

  const runMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ actions: number; strategiesExecuted: number; reason?: string }>(
        `/me/agents/${id}/run`,
        { method: "POST" }
      ),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      alert(
        result.strategiesExecuted > 0
          ? `Executed ${result.strategiesExecuted} strategy cycles, triggered ${result.actions} actions.`
          : `Run complete. No strategies triggered. Reason: ${result.reason || "None"}`
      );
    },
  });

  const agents = data?.agents ?? [];

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 flex-shrink-0">
        <div>
          <h2 className="text-2xl font-bold text-title-text">Trading Agents</h2>
          <p className="text-muted-text mt-1 text-sm">Autonomous agents and strategies execution dashboard</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium text-sm transition-colors"
        >
          <Plus className="w-4 h-4" /> New Agent
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-6 pb-6 custom-scrollbar">
          {showForm && (
            <div className="glass-card p-6 mb-6 space-y-4 max-w-lg">
              <div>
                <label className="block text-xs text-muted-text mb-1">Agent Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="input-premium"
                  placeholder="e.g. Conservative Rebalancer"
                />
              </div>

              <div>
                <label className="block text-xs text-muted-text mb-1">AI Mode</label>
                <div className="grid grid-cols-3 gap-2">
                  {(["off", "advisor", "autonomous"] as AiMode[]).map((m) => (
                    <button
                      key={m}
                      onClick={() => setAiMode(m)}
                      className={classNames(
                        "p-2.5 rounded-lg border text-center transition-colors",
                        aiMode === m ? "bg-brand-500/10 border-brand-500/30 text-brand-400" : "bg-input-bg border-divider-color text-muted-text"
                      )}
                    >
                      <p className="text-xs font-medium capitalize">{m}</p>
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-muted-text/80 mt-1.5">
                  {aiMode === "off" && "Run strategies only — no AI decisions."}
                  {aiMode === "advisor" && "AI logs decisions but does not execute trades."}
                  {aiMode === "autonomous" && "AI executes its own trades alongside strategies."}
                </p>
              </div>

              <div>
                <label className="block text-xs text-muted-text mb-1">Max Position Per Trade (%)</label>
                <input
                  type="number"
                  value={maxPositionPct}
                  onChange={(e) => setMaxPositionPct(e.target.value)}
                  className="w-full px-3 py-2.5 bg-input-bg border border-divider-color rounded-lg text-sm text-title-text focus:border-brand-500 focus:outline-none"
                />
              </div>

              <button
                onClick={() => createMutation.mutate({
                  name: name || "Agent",
                  aiMode,
                  config: { maxPositionPct: Number(maxPositionPct) || 25 },
                })}
                disabled={createMutation.isPending}
                className="w-full py-2.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
              >
                {createMutation.isPending ? "Creating..." : "Create Agent"}
              </button>
            </div>
          )}

          <div className="space-y-4 max-w-3xl">
            {agents.length === 0 ? (
              <div className="glass-card p-8 text-center">
                <Bot className="w-12 h-12 text-muted-text/40 mx-auto mb-3" />
                <p className="text-muted-text">No agents yet</p>
                <p className="text-xs text-muted-text/75 mt-1">Create an agent and assign strategies to start trading</p>
              </div>
            ) : (
              agents.map((a) => {
                const isOpen = expanded === a.id;
                const lastDecision = (a.state as { lastDecision?: { reason?: string; action?: string; time?: string } })?.lastDecision;
                const lastRun = (a.state as { lastRun?: string })?.lastRun;
                const strategyCount = a.strategies?.length ?? 0;
                const activeCount = a.strategies?.filter((s) => s.isActive).length ?? 0;

                return (
                  <div key={a.id} className={classNames("glass-card p-5", !a.isActive && "opacity-50")}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 flex-1 cursor-pointer min-w-0" onClick={() => setExpanded(isOpen ? null : a.id)}>
                        <div className="w-10 h-10 rounded-xl bg-brand-500/10 flex items-center justify-center flex-shrink-0">
                          <Bot className="w-5 h-5 text-brand-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-sm font-semibold text-title-text">{a.name}</h3>
                            {a.aiMode !== "off" && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-purple-500/10 text-purple-400 rounded text-[10px] font-medium">
                                <Sparkles className="w-2.5 h-2.5" /> AI {a.aiMode}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-muted-text mt-0.5">
                            {activeCount}/{strategyCount} strategies active
                            {lastRun && ` · last run ${formatDate(lastRun)}`}
                          </p>
                          <p className="text-[10px] text-muted-text/70 mt-1 flex items-center gap-1">
                            Created {formatDate(a.createdAt)}
                            <ChevronDown className={classNames("w-3 h-3 transition-transform", isOpen && "rotate-180")} />
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => runMutation.mutate(a.id)}
                          disabled={runMutation.isPending}
                          className="p-1.5 rounded-lg hover:bg-green-500/10 text-green-400 transition-colors"
                          title="Run agent cycle now"
                        >
                          {runMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                        </button>
                        <button
                          onClick={() => toggleMutation.mutate({ id: a.id, isActive: !a.isActive })}
                          className="p-1 rounded hover:bg-bg-hover transition-colors"
                        >
                          {a.isActive ? <ToggleRight className="w-5 h-5 text-green-400" /> : <ToggleLeft className="w-5 h-5 text-muted-text" />}
                        </button>
                        <button
                          onClick={() => deleteMutation.mutate(a.id)}
                          className="p-1 rounded hover:bg-bg-hover text-red-400 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {runMsg[a.id] && (
                      <div className="mt-3 px-3 py-2 bg-input-bg/50 rounded-lg text-xs text-title-text">{runMsg[a.id]}</div>
                    )}

                    {isOpen && (
                      <div className="mt-4 pt-4 border-t border-divider-color space-y-4">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-text">AI Mode:</span>
                          <div className="flex gap-1">
                            {(["off", "advisor", "autonomous"] as AiMode[]).map((m) => (
                              <button
                                key={m}
                                onClick={() => aiModeMutation.mutate({ id: a.id, aiMode: m })}
                                className={classNames(
                                  "px-2 py-1 rounded text-[10px] font-medium transition-colors",
                                  a.aiMode === m ? "bg-brand-500/20 text-brand-400" : "bg-input-bg text-muted-text hover:text-title-text"
                                )}
                              >
                                {m}
                              </button>
                            ))}
                          </div>
                        </div>

                        {lastDecision && (
                          <div className="bg-purple-500/5 border border-purple-500/20 rounded-lg p-3">
                            <p className="text-[10px] text-purple-400 uppercase font-semibold mb-1">Last AI Decision</p>
                            <p className="text-xs text-title-text">
                              <span className="text-purple-400">{lastDecision.action}</span> — {lastDecision.reason}
                            </p>
                          </div>
                        )}

                        <AgentStrategies agentId={a.id} wallets={wallets} />
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    );
  }
