import React from "react";

interface PriceDisplayProps {
  price: number | string;
  currency?: string;
  change24h?: number;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

export const PriceDisplay: React.FC<PriceDisplayProps> = ({
  price,
  currency = "$",
  change24h,
  size = "md",
  className = "",
}) => {
  const numericPrice = typeof price === "number" ? price : parseFloat(price);
  const formattedPrice = isNaN(numericPrice)
    ? price
    : numericPrice.toLocaleString("en-US", {
        minimumFractionDigits: numericPrice < 1 ? 4 : 2,
        maximumFractionDigits: numericPrice < 1 ? 6 : 2,
      });

  const sizeClasses = {
    sm: "text-xs",
    md: "text-sm",
    lg: "text-lg",
    xl: "text-2xl sm:text-3xl",
  };

  return (
    <div className={`inline-flex items-baseline gap-1.5 font-mono ${className}`}>
      <span className={`font-bold text-[#FCFCFC] tracking-tight ${sizeClasses[size]}`}>
        {currency}
        {formattedPrice}
      </span>
      {change24h !== undefined && (
        <span
          className={`text-[11px] font-semibold ${
            change24h >= 0 ? "text-[#00E676]" : "text-[#FF2A4B]"
          }`}
        >
          {change24h >= 0 ? "+" : ""}
          {change24h.toFixed(2)}%
        </span>
      )}
    </div>
  );
};

export default PriceDisplay;
