import React from "react";
import { Sparkles, Brain, Cpu, Activity } from "lucide-react";

export type AIIndicatorState = "active" | "processing" | "evaluating" | "idle";

interface AIIndicatorProps {
  state?: AIIndicatorState;
  label?: string;
  className?: string;
  showIconContainer?: boolean;
}

export const AIIndicator: React.FC<AIIndicatorProps> = ({
  state = "active",
  label,
  className = "",
  showIconContainer = true,
}) => {
  const displayLabel = label || {
    active: "AI AGENT ACTIVE",
    processing: "PROCESSING SIGNAL",
    evaluating: "EVALUATING SPREADS",
    idle: "AI STANDBY",
  }[state];

  const iconElement = {
    active: <Brain className="w-3.5 h-3.5 text-[#DEA34F]" strokeWidth={1.75} />,
    processing: <Cpu className="w-3.5 h-3.5 text-[#DEA34F] animate-pulse" strokeWidth={1.75} />,
    evaluating: <Activity className="w-3.5 h-3.5 text-[#DEA34F]" strokeWidth={1.75} />,
    idle: <Sparkles className="w-3.5 h-3.5 text-[#9A9DA5]" strokeWidth={1.75} />,
  }[state];

  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      {showIconContainer ? (
        <div className="w-7 h-7 rounded-lg bg-[#4B4032] border border-[#DEA34F]/30 flex items-center justify-center shrink-0">
          {iconElement}
        </div>
      ) : (
        iconElement
      )}
      <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold text-[#DEA34F] tracking-wide">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            state === "active" ? "bg-[#00E676] animate-ping" : "bg-[#DEA34F]"
          }`}
        />
        <span>{displayLabel}</span>
      </div>
    </div>
  );
};

export default AIIndicator;
