import React from "react";

interface AIConfidenceProps {
  confidence: number;
  label?: string;
  className?: string;
}

export const AIConfidence: React.FC<AIConfidenceProps> = ({
  confidence,
  label = "AI CONFIDENCE",
  className = "",
}) => {
  const clampedConfidence = Math.max(0, Math.min(100, confidence));

  return (
    <div className={`inline-flex items-center gap-2.5 px-3 py-1 rounded-lg bg-[#262729] border border-[#3A393B] ${className}`}>
      <span className="text-[10px] font-mono font-bold tracking-wider text-[#9A9DA5] uppercase">
        {label}
      </span>
      <div className="w-16 h-1.5 rounded-full bg-[#192939] overflow-hidden">
        <div
          className="h-full rounded-full bg-[#DEA34F] transition-all duration-300"
          style={{ width: `${clampedConfidence}%` }}
        />
      </div>
      <span className="font-mono text-xs font-bold text-[#DEA34F]">
        {clampedConfidence}%
      </span>
    </div>
  );
};

export default AIConfidence;
