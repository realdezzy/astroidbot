import { useState, useRef, useEffect } from "react";
import { ChevronDown, Check, Wallet } from "lucide-react";
import { classNames } from "../lib/utils";

interface Wallet {
  id: number;
  address: string;
  name: string;
  balance: number;
}

interface MultiWalletSelectProps {
  wallets: Wallet[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  className?: string;
}

export function MultiWalletSelect({ wallets, selectedIds, onChange, className }: MultiWalletSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggle = (id: number) => {
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter((i) => i !== id)
        : [...selectedIds, id]
    );
  };

  const selectAll = () => onChange(wallets.map((w) => w.id));
  const deselectAll = () => onChange([]);

  const selectedCount = selectedIds.length;

  return (
    <div ref={ref} className={classNames("relative", className)}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 bg-input-bg border border-divider-color rounded-2xl text-sm text-title-text hover:border-brand-500/50 transition-all duration-200"
      >
        <div className="flex items-center gap-2">
          <Wallet className="w-4 h-4 text-muted-text" />
          <span className={selectedCount > 0 ? "text-title-text font-medium" : "text-muted-text/60"}>
            {selectedCount > 0 ? `${selectedCount} wallet${selectedCount > 1 ? "s" : ""}` : "Select wallets..."}
          </span>
        </div>
        <ChevronDown className={classNames("w-4 h-4 text-muted-text transition-transform duration-200", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute z-50 mt-2 w-full bg-sidebar-bg border border-divider-color rounded-2xl shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-divider-color">
            <button onClick={selectAll} className="text-xs text-brand-400 hover:text-brand-300">Select all</button>
            <button onClick={deselectAll} className="text-xs text-muted-text hover:text-title-text">Clear</button>
          </div>
          <div className="max-h-56 overflow-y-auto">
            {wallets.map((w) => {
              const sel = selectedIds.includes(w.id);
              return (
                <button
                  key={w.id}
                  onClick={() => toggle(w.id)}
                  className={classNames(
                    "w-full flex items-center gap-3 px-4 py-3 text-sm text-left hover:bg-bg-hover transition-colors",
                    sel && "bg-brand-500/5"
                  )}
                >
                  <div className={classNames(
                    "w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors",
                    sel ? "bg-brand-500 border-brand-500" : "border-divider-color"
                  )}>
                    {sel && <Check className="w-3 h-3 text-white" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-title-text">{w.name}</span>
                    <span className="text-muted-text ml-2 text-xs">{w.balance.toFixed(2)} STX</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
