import { classNames } from "../lib/utils";

interface StatusBadgeProps {
  status: string;
}

const statusConfig: Record<string, { label: string; className: string }> = {
  RUNNING: {
    label: "Running",
    className: "bg-success-500/20 text-success-400 border-success-500/30",
  },
  HALTED: {
    label: "Halted",
    className: "bg-danger-500/20 text-danger-400 border-danger-500/30",
  },
  IDLE: {
    label: "Idle",
    className: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  },
  ERROR: {
    label: "Error",
    className: "bg-danger-500/20 text-danger-400 border-danger-500/30",
  },
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.IDLE;

  return (
    <span
      className={classNames(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border",
        config.className
      )}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {config.label}
    </span>
  );
}
