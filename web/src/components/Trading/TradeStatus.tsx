import React from "react";
import { CheckCircle2, Clock, XCircle, AlertCircle, Play } from "lucide-react";

export type TradeStatusType = "pending" | "executed" | "cancelled" | "failed" | "active";

interface TradeStatusProps {
  status: TradeStatusType;
  className?: string;
}

export const TradeStatus: React.FC<TradeStatusProps> = ({ status, className = "" }) => {
  const configs = {
    executed: {
      label: "EXECUTED",
      icon: <CheckCircle2 className="w-3 h-3 text-[#00E676]" strokeWidth={2} />,
      styles: "text-[#00E676] bg-[#00E676]/10 border-[#00E676]/30",
    },
    active: {
      label: "ACTIVE",
      icon: <Play className="w-3 h-3 text-[#00E676] fill-[#00E676]" strokeWidth={1.5} />,
      styles: "text-[#00E676] bg-[#00E676]/10 border-[#00E676]/30",
    },
    pending: {
      label: "PENDING",
      icon: <Clock className="w-3 h-3 text-[#DEA34F] animate-spin" strokeWidth={2} />,
      styles: "text-[#DEA34F] bg-[#4B4032]/40 border-[#DEA34F]/30",
    },
    cancelled: {
      label: "CANCELLED",
      icon: <XCircle className="w-3 h-3 text-[#9A9DA5]" strokeWidth={2} />,
      styles: "text-[#9A9DA5] bg-[#2D2B2B] border-[#3A393B]",
    },
    failed: {
      label: "FAILED",
      icon: <AlertCircle className="w-3 h-3 text-[#FF2A4B]" strokeWidth={2} />,
      styles: "text-[#FF2A4B] bg-[#FF2A4B]/10 border-[#FF2A4B]/30",
    },
  };

  const config = configs[status] || configs.pending;

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border font-mono text-[10px] font-bold tracking-wider ${config.styles} ${className}`}
    >
      {config.icon}
      <span>{config.label}</span>
    </span>
  );
};

export default TradeStatus;
