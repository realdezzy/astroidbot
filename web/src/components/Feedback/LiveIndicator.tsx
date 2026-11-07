import React from "react";

interface LiveIndicatorProps {
  isLive?: boolean;
  label?: string;
  className?: string;
}

export const LiveIndicator: React.FC<LiveIndicatorProps> = ({
  isLive = true,
  label = "LIVE",
  className = "",
}) => {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md font-mono text-[10px] font-bold tracking-wider uppercase border ${
        isLive
          ? "bg-[#00E676]/10 text-[#00E676] border-[#00E676]/30"
          : "bg-bg-hover text-muted-text border-card-border"
      } ${className}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          isLive ? "bg-[#00E676] animate-pulse" : "bg-muted-text"
        }`}
      />
      <span>{label}</span>
    </span>
  );
};

export default LiveIndicator;
