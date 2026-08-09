import React from "react";
import { useNavigate } from "react-router-dom";

export interface MarqueeTokenItem {
  id?: string | number;
  symbol: string;
  priceChange24h?: number | null;
  priceChange6h?: number | null;
  priceUsd?: number | null;
  chainId?: string;
  contractId?: string;
}

interface MarqueeTickerProps {
  tokens?: MarqueeTokenItem[];
  isLoading?: boolean;
}

export const MarqueeTicker: React.FC<MarqueeTickerProps> = ({ tokens = [], isLoading = false }) => {
  const navigate = useNavigate();

  // Top 20 24h performing tokens sorted by 24h gain
  const topTokens = React.useMemo(() => {
    return [...tokens]
      .filter((t) => (t.priceChange24h ?? 0) !== 0)
      .sort((a, b) => (b.priceChange24h ?? 0) - (a.priceChange24h ?? 0))
      .slice(0, 20);
  }, [tokens]);

  if (isLoading || topTokens.length === 0) {
    return null;
  }

  // Duplicate list to achieve continuous seamless marquee loop
  const displayItems = [...topTokens, ...topTokens];

  return (
    <div className="w-full bg-[#0d1117] border-b border-[#21262d] overflow-hidden py-1.5 px-2 select-none">
      <div className="flex items-center space-x-6 animate-marquee whitespace-nowrap hover:[animation-play-state:paused]">
        {displayItems.map((item, index) => {
          const rank = (index % topTokens.length) + 1;
          const change = item.priceChange24h ?? item.priceChange6h ?? 0;
          const isPositive = change >= 0;

          return (
            <div
              key={`${item.symbol}-${index}`}
              onClick={() => {
                if (item.chainId && item.contractId) {
                  navigate(`/tokens/${item.chainId}/${encodeURIComponent(item.contractId)}`);
                } else {
                  navigate(`/tokens?search=${item.symbol}`);
                }
              }}
              className="inline-flex items-center space-x-1.5 text-xs cursor-pointer hover:bg-[#161b22] px-2 py-0.5 rounded transition-colors"
            >
              <span className="font-semibold text-gray-400">#{rank}</span>
              <span className="font-bold text-gray-200">{item.symbol}</span>
              <span className={`font-semibold ${isPositive ? "text-emerald-400" : "text-rose-400"}`}>
                {isPositive ? "+" : ""}
                {change.toFixed(1)}%
              </span>
              <span className="text-[10px] text-gray-500 font-mono">24h</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
