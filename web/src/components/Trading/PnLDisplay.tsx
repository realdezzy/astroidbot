import React from "react";
import { TrendingUp, TrendingDown } from "lucide-react";

interface PnLDisplayProps {
  amount: number;
  percentage?: number;
  currency?: string;
  showIcon?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export const PnLDisplay: React.FC<PnLDisplayProps> = ({
  amount,
  percentage,
  currency = "$",
  showIcon = true,
  size = "md",
  className = "",
}) => {
  const isPositive = amount >= 0;
  const colorClass = isPositive ? "text-[#00E676]" : "text-[#FF2A4B]";
  const sign = isPositive ? "+" : "-";
  const absAmount = Math.abs(amount);

  const sizeClasses = {
    sm: "text-xs",
    md: "text-sm",
    lg: "text-lg font-bold",
  };

  return (
    <div className={`inline-flex items-center gap-1.5 font-mono ${colorClass} ${className}`}>
      {showIcon && (
        isPositive ? (
          <TrendingUp className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
        ) : (
          <TrendingDown className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
        )
      )}
      <span className={`font-semibold ${sizeClasses[size]}`}>
        {sign}{currency}{absAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
      {percentage !== undefined && (
        <span className="text-[11px] opacity-85">
          ({isPositive ? "+" : ""}{percentage.toFixed(2)}%)
        </span>
      )}
    </div>
  );
};

export default PnLDisplay;
