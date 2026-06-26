import { formatNumber, classNames } from "../../lib/utils";

export interface PerpPosition {
  id: number;
  userId: number;
  walletId: number;
  market: string;
  direction: "LONG" | "SHORT";
  size: number;
  leverage: number;
  entryPrice: number;
  liquidationPrice: number;
  margin: number;
  status: "OPEN" | "CLOSED" | "LIQUIDATED";
  txId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PerpPositionRowProps {
  position: PerpPosition;
  onClose: (id: number) => void;
  isClosing: boolean;
}

export function PerpPositionRow({ position, onClose, isClosing }: PerpPositionRowProps) {
  const isLong = position.direction === "LONG";
  const statusColors = {
    OPEN: "bg-green-500/10 border-green-500/20 text-green-400",
    CLOSED: "bg-gray-500/10 border-gray-500/20 text-gray-400",
    LIQUIDATED: "bg-red-500/10 border-red-500/20 text-red-400",
  };

  return (
    <tr className="border-b border-divider-color hover:bg-bg-hover/30 transition-colors">
      <td className="py-3.5 px-4 font-semibold text-title-text text-sm">
        {position.market}
      </td>
      <td className="py-3.5 px-4">
        <span
          className={classNames(
            "px-2.5 py-1 rounded-lg text-xs font-bold border",
            isLong
              ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
              : "bg-rose-500/10 border-rose-500/20 text-rose-400"
          )}
        >
          {position.direction}
        </span>
      </td>
      <td className="py-3.5 px-4 text-sm font-medium text-title-text">
        {formatNumber(position.size, 2)} STX
        <span className="text-xs text-muted-text block mt-0.5">
          Margin: {formatNumber(position.margin, 2)} STX
        </span>
      </td>
      <td className="py-3.5 px-4 text-sm font-semibold text-title-text">
        {position.leverage}x
      </td>
      <td className="py-3.5 px-4 text-sm text-title-text">
        ${formatNumber(position.entryPrice, 4)}
      </td>
      <td className="py-3.5 px-4 text-sm font-medium text-rose-400">
        ${formatNumber(position.liquidationPrice, 4)}
      </td>
      <td className="py-3.5 px-4">
        <span
          className={classNames(
            "px-2 py-0.5 rounded text-xs font-semibold border",
            statusColors[position.status] || "bg-gray-500/10 border-gray-500/20 text-gray-400"
          )}
        >
          {position.status}
        </span>
      </td>
      <td className="py-3.5 px-4 text-xs font-mono text-muted-text">
        {position.txId ? (
          <a
            href={`https://explorer.stacks.co/txid/${position.txId}?chain=mainnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-brand-400 underline transition-colors"
          >
            {position.txId.slice(0, 8)}...
          </a>
        ) : (
          "—"
        )}
      </td>
      <td className="py-3.5 px-4 text-right">
        {position.status === "OPEN" && (
          <button
            onClick={() => onClose(position.id)}
            disabled={isClosing}
            className="px-3 py-1 bg-red-500/10 hover:bg-red-500/20 disabled:opacity-50 text-red-400 hover:text-red-300 rounded-lg text-xs font-semibold border border-red-500/20 transition-all"
          >
            {isClosing ? "Closing..." : "Close"}
          </button>
        )}
      </td>
    </tr>
  );
}
