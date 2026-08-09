import React from "react";

interface ChainDexBadgeProps {
  chainId?: string;
  dexId?: string;
  className?: string;
}

const CHAIN_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  solana: { bg: "bg-purple-900/80 border-purple-500", text: "text-purple-300", label: "SOL" },
  stacks: { bg: "bg-orange-900/80 border-orange-500", text: "text-orange-300", label: "STX" },
  base: { bg: "bg-blue-900/80 border-blue-500", text: "text-blue-300", label: "BASE" },
  ethereum: { bg: "bg-indigo-900/80 border-indigo-500", text: "text-indigo-300", label: "ETH" },
  celo: { bg: "bg-emerald-900/80 border-emerald-500", text: "text-emerald-300", label: "CELO" },
  arc: { bg: "bg-cyan-900/80 border-cyan-500", text: "text-cyan-300", label: "ARC" },
};

const DEX_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  pumpswap: { bg: "bg-pink-600", text: "text-white", label: "PS" },
  raydium: { bg: "bg-cyan-600", text: "text-white", label: "RAY" },
  jupiter: { bg: "bg-lime-600", text: "text-white", label: "JUP" },
  "uniswap-v3": { bg: "bg-pink-500", text: "text-white", label: "UNI" },
  alex: { bg: "bg-amber-600", text: "text-white", label: "ALX" },
  velar: { bg: "bg-sky-600", text: "text-white", label: "VEL" },
  bitflow: { bg: "bg-teal-600", text: "text-white", label: "BIT" },
};

export const ChainDexBadge: React.FC<ChainDexBadgeProps> = ({ chainId = "", dexId = "", className = "" }) => {
  const chainKey = chainId.split(":")[0]?.toLowerCase() || "solana";
  const dexKey = dexId.toLowerCase();

  const chainInfo = CHAIN_COLORS[chainKey] || { bg: "bg-gray-800 border-gray-600", text: "text-gray-300", label: chainKey.slice(0, 3).toUpperCase() };
  const dexInfo = DEX_COLORS[dexKey] || { bg: "bg-gray-700", text: "text-gray-200", label: dexKey.slice(0, 3).toUpperCase() };

  return (
    <div className={`relative inline-flex items-center ${className}`}>
      {/* Primary Chain Badge */}
      <span
        title={`Chain: ${chainId}`}
        className={`w-5 h-5 rounded-full border ${chainInfo.bg} ${chainInfo.text} flex items-center justify-center text-[9px] font-bold shadow-sm shrink-0`}
      >
        {chainInfo.label[0]}
      </span>

      {/* Secondary DEX Overlay Badge */}
      <span
        title={`DEX: ${dexId}`}
        className={`-ml-1.5 -mt-1.5 w-3.5 h-3.5 rounded-full ${dexInfo.bg} ${dexInfo.text} border border-[#0d1117] flex items-center justify-center text-[7px] font-black shadow-sm shrink-0`}
      >
        {dexInfo.label[0]}
      </span>
    </div>
  );
};
