import { RotateCw, Pause } from "lucide-react";
import { classNames } from "../lib/utils";

interface AutoRefreshToggleProps {
  isActive: boolean;
  toggle: () => void;
  timeLeft: number;
}

function formatTimeLeft(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AutoRefreshToggle({
  isActive,
  toggle,
  timeLeft,
}: AutoRefreshToggleProps) {
  return (
    <button
      onClick={toggle}
      className={classNames(
        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
        isActive
          ? "bg-green-500/15 text-green-400 hover:bg-green-500/25"
          : "bg-gray-700 text-gray-400 hover:bg-gray-600"
      )}
      title={
        isActive
          ? `Auto-refresh active (${formatTimeLeft(timeLeft)} remaining)`
          : "Auto-refresh paused"
      }
    >
      {isActive ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
          </span>
          <RotateCw className="w-3 h-3" />
          <span>{formatTimeLeft(timeLeft)}</span>
        </>
      ) : (
        <>
          <Pause className="w-3 h-3" />
          <span>Paused</span>
        </>
      )}
    </button>
  );
}
