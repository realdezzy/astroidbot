import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff } from "lucide-react";
import { apiFetch } from "../lib/api";

type Channel = "TELEGRAM" | "PUSH";
interface Preference { id: number; channel: Channel; eventType: string; enabled: boolean; cadence: string; }

const events = [
  ["TRADE_STATUS", "Trades", "Submission, confirmation, and failure"],
  ["ORDER_STATUS", "Limit orders", "Triggers, fills, and failures"],
  ["AGENT_DECISION", "Agent decisions", "Actions, skips, and automatic pauses"],
  ["RISK_EVENT", "Risk controls", "Warnings and limit breaches"],
  ["LOW_GAS", "Low gas", "Wallet gas balance warnings"],
] as const;

export function AlertPreferences() {
  const client = useQueryClient();
  const { data = [] } = useQuery<Preference[]>({ queryKey: ["alert-preferences"], queryFn: () => apiFetch("/me/alerts") });
  const mutation = useMutation({
    mutationFn: (value: { channel: Channel; eventType: string; enabled: boolean }) => apiFetch("/me/alerts", { method: "PUT", body: JSON.stringify(value) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["alert-preferences"] }),
  });
  const enabled = (channel: Channel, eventType: string) => data.find((p) => p.channel === channel && p.eventType === eventType)?.enabled ?? true;

  return (
    <section className="glass-card p-5" aria-labelledby="alert-preferences-title">
      <div className="flex items-center gap-2"><Bell className="h-4 w-4 text-brand-400" /><h3 id="alert-preferences-title" className="font-medium text-title-text">Alert preferences</h3></div>
      <p className="mt-1 text-xs text-muted-text">Choose where execution, agent, and risk updates reach you.</p>
      <div className="mt-4 divide-y divide-divider-color">
        {events.map(([eventType, label, description]) => (
          <div key={eventType} className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1"><p className="text-sm font-medium text-title-text">{label}</p><p className="text-xs text-muted-text">{description}</p></div>
            {(["TELEGRAM", "PUSH"] as const).map((channel) => {
              const on = enabled(channel, eventType);
              return <button key={channel} type="button" disabled={mutation.isPending} aria-pressed={on}
                onClick={() => mutation.mutate({ channel, eventType, enabled: !on })}
                className={`rounded-lg border px-2.5 py-1.5 text-xs ${on ? "border-brand-500/50 bg-brand-500/10 text-brand-300" : "border-divider-color text-muted-text"}`}>
                {on ? <Bell className="mr-1 inline h-3 w-3" /> : <BellOff className="mr-1 inline h-3 w-3" />}{channel === "TELEGRAM" ? "Telegram" : "Push"}
              </button>;
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
