import { ExternalLink } from "lucide-react";
import { formatNumber, formatDate, classNames } from "../lib/utils";

interface TradeRowProps {
  trade: {
    id: number;
    direction: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: number;
    amountOut: number;
    feeAmount?: number;
    feeBps?: number;
    txId: string | null;
    status: string;
    errorMessage: string | null;
    createdAt: string;
    confirmedAt: string | null;
    walletName?: string;
  };
}

const statusStyles: Record<string, string> = {
  PENDING: "text-gray-400 bg-gray-500/10",
  BROADCAST: "text-yellow-400 bg-yellow-500/10",
  CONFIRMED: "text-green-400 bg-green-500/10",
  FAILED: "text-red-400 bg-red-500/10",
};

export function TradeRow({ trade }: TradeRowProps) {
  const isBuy = trade.direction === "BUY";

  return (
    <tr className="border-b border-divider-color hover:bg-bg-hover transition-colors">
      <td className="py-3 px-4 text-sm text-muted-text">
        {formatDate(trade.createdAt)}
      </td>
      <td className="py-3 px-4">
        <span
          className={classNames(
            "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium",
            isBuy ? "text-green-400 bg-green-500/10" : "text-red-400 bg-red-500/10"
          )}
        >
          {trade.direction}
        </span>
      </td>
      <td className="py-3 px-4 text-sm text-title-text">
        {formatNumber(trade.amountIn, 4)} {trade.tokenIn.split("::").pop() ?? trade.tokenIn}
      </td>
      <td className="py-3 px-4 text-sm text-title-text">
        {formatNumber(trade.amountOut, 4)} {trade.tokenOut.split("::").pop() ?? trade.tokenOut}
      </td>
      <td className="py-3 px-4 text-sm">
        <span
          className={classNames(
            (trade.feeBps ?? 30) > 100
              ? "text-amber-400"
              : "text-muted-text/60"
          )}
        >
          {formatNumber(trade.feeAmount ?? 0, 4)} ({trade.feeBps ?? 30} bps)
        </span>
      </td>
      <td className="py-3 px-4">
        <span
          className={classNames(
            "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium",
            statusStyles[trade.status] ?? statusStyles.PENDING
          )}
        >
          {trade.status}
        </span>
      </td>
      <td className="py-3 px-4 text-sm text-muted-text">
        {trade.txId ? (
          <a
            href={`https://explorer.hiro.so/txid/${trade.txId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-brand-400 hover:text-brand-300"
          >
            <ExternalLink className="w-3 h-3" />
            {trade.txId.slice(0, 8)}...
          </a>
        ) : (
          "-"
        )}
      </td>
    </tr>
  );
}
