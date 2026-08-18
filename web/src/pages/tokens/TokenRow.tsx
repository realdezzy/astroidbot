import { memo } from "react";
import { Link } from "react-router-dom";
import { Lock, Unlock, ShieldCheck, ArrowUpRight } from "lucide-react";
import { classNames } from "../../lib/utils";
import { ChainDexBadge } from "../../components/ChainDexBadge";
import {
  formatAge,
  formatCount,
  formatPercent,
  formatPrice,
  formatUsdCompact,
} from "./format";
import type { DexToken, Timeframe } from "./types";

/**
 * Percentage cell.
 *
 * Colour is the signal here, not the sign character — at this density the
 * eye reads hue before it reads text. Null renders as a muted dash so an
 * unmeasured window is visibly different from a flat one.
 */
export function Change({ value, emphasised }: { value: number | null; emphasised?: boolean }) {
  if (value == null || !Number.isFinite(value)) {
    return <span className="text-muted-text/50">—</span>;
  }

  const positive = value >= 0;
  return (
    <span
      className={classNames(
        "tabular-nums",
        emphasised ? "font-bold" : "font-semibold",
        positive ? "text-success-400" : "text-danger-400"
      )}
    >
      {formatPercent(value)}
    </span>
  );
}

/** Small chain pill. Colour is derived from the id so it's stable per chain. */
export function ChainPill({ chainId, label }: { chainId: string; label: string }) {
  return (
    <span
      className={classNames(
        "px-1.5 py-0.5 text-[9px] font-bold rounded uppercase tracking-wide border",
        chainTone(chainId)
      )}
    >
      {label}
    </span>
  );
}

/**
 * Chain colours.
 *
 * Keyed on the network segment rather than the full ChainId so mainnet and
 * testnet of the same chain read as the same brand.
 */
function chainTone(chainId: string): string {
  switch (chainId.split(":")[0]) {
    case "robinhood":
      return "bg-success-500/15 text-success-400 border-success-500/30";
    case "arc":
      return "bg-cyan-500/15 text-cyan-400 border-cyan-500/30";
    case "solana":
      return "bg-purple-500/15 text-purple-400 border-purple-500/30";
    case "base":
      return "bg-blue-500/15 text-blue-400 border-blue-500/30";
    case "ethereum":
      return "bg-indigo-500/15 text-indigo-400 border-indigo-500/30";
    case "stacks":
      return "bg-orange-500/15 text-orange-400 border-orange-500/30";
    case "celo":
      return "bg-warning-500/15 text-warning-400 border-warning-500/30";
    default:
      return "bg-brand-500/15 text-brand-400 border-brand-500/30";
  }
}

interface TokenRowProps {
  token: DexToken;
  rank: number;
  timeframe: Timeframe;
  isBlocked: boolean;
  canBlock: boolean;
  onTrade: (token: DexToken) => void;
  onToggleBlock: (token: DexToken, blocked: boolean) => void;
}

/**
 * One row of the discovery table.
 *
 * Memoised because the table renders up to 100 rows on a refetch interval and
 * the vast majority are unchanged between polls.
 */
export const TokenRow = memo(function TokenRow({
  token,
  rank,
  timeframe,
  isBlocked,
  canBlock,
  onTrade,
  onToggleBlock,
}: TokenRowProps) {
  const buys = token.txns24h?.buys;
  const sells = token.txns24h?.sells;
  const total = (buys ?? 0) + (sells ?? 0);
  const haveTxns = buys != null || sells != null;
  const buyShare = total > 0 ? ((buys ?? 0) / total) * 100 : 50;

  return (
    <tr
      className={classNames(
        "group border-b border-divider-color/40 transition-colors hover:bg-bg-hover",
        isBlocked && "opacity-50"
      )}
    >
      <td className="py-2.5 px-3 text-right font-mono text-[11px] text-muted-text/70 tabular-nums">
        #{rank}
      </td>

      {/* Token identity */}
      <td className="py-2.5 px-3">
        <Link
          to={`/tokens/${encodeURIComponent(token.chainId)}/${encodeURIComponent(token.contractId)}`}
          className="flex items-center gap-2.5 min-w-0 group/link"
        >
          {token.icon ? (
            <img
              src={token.icon}
              alt=""
              loading="lazy"
              className="w-7 h-7 rounded-full object-cover border border-card-border shrink-0"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
              }}
            />
          ) : (
            <div className="w-7 h-7 rounded-full bg-brand-500/20 border border-brand-500/30 flex items-center justify-center text-[10px] font-bold text-brand-400 shrink-0">
              {token.symbol.slice(0, 2).toUpperCase()}
            </div>
          )}

          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-title-text text-[13px] truncate max-w-[9rem] group-hover/link:text-brand-400 transition-colors">
                {token.symbol}
              </span>
              {token.isVerified && (
                <ShieldCheck className="w-3 h-3 text-blue-400 shrink-0" aria-label="Verified" />
              )}
              <span className="text-muted-text/60 text-[11px] truncate max-w-[10rem]">
                {token.name}
              </span>
            </div>
            <div className="flex items-center gap-1 mt-0.5">
              <ChainDexBadge chainId={token.chainId} dexId={token.dexId} />
              <ChainPill chainId={token.chainId} label={token.chainName} />
              <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-badge-bg text-muted-text uppercase">
                {token.dexId}
              </span>
            </div>
          </div>
        </Link>
      </td>

      <td className="py-2.5 px-3 text-right font-semibold text-title-text tabular-nums">
        {formatUsdCompact(token.marketCapUsd)}
      </td>

      <td className="py-2.5 px-3 text-right font-mono font-semibold text-title-text tabular-nums">
        {formatPrice(token.priceUsd)}
      </td>

      <td className="py-2.5 px-3 text-right font-mono text-[11px] text-muted-text tabular-nums">
        {formatAge(token.pairCreatedAt)}
      </td>

      {/* Transactions, with the buy/sell split as a bar */}
      <td className="py-2.5 px-3 text-right tabular-nums">
        {haveTxns ? (
          <>
            <div className="text-[12px] font-semibold text-title-text">{formatCount(total)}</div>
            <div className="mt-1 flex items-center justify-end gap-1">
              <span className="text-[9px] text-success-400 tabular-nums">{formatCount(buys)}</span>
              <div className="w-10 h-[3px] rounded-full overflow-hidden flex bg-danger-500/70">
                <div className="bg-success-500 h-full" style={{ width: `${buyShare}%` }} />
              </div>
              <span className="text-[9px] text-danger-400 tabular-nums">{formatCount(sells)}</span>
            </div>
          </>
        ) : (
          <span className="text-muted-text/50">—</span>
        )}
      </td>

      <td className="py-2.5 px-3 text-right font-semibold text-title-text tabular-nums">
        {formatUsdCompact(token.volume24h)}
      </td>

      {/* The selected timeframe is emphasised so the sorted column reads first */}
      <td className="py-2.5 px-3 text-right">
        <Change value={token.priceChange.m5} emphasised={timeframe === "m5"} />
      </td>
      <td className="py-2.5 px-3 text-right">
        <Change value={token.priceChange.h1} emphasised={timeframe === "h1"} />
      </td>
      <td className="py-2.5 px-3 text-right">
        <Change value={token.priceChange.h6} emphasised={timeframe === "h6"} />
      </td>
      <td className="py-2.5 px-3 text-right">
        <Change value={token.priceChange.h24} emphasised={timeframe === "h24"} />
      </td>

      <td className="py-2.5 px-3 text-right font-semibold text-title-text tabular-nums">
        {formatUsdCompact(token.liquidityUsd)}
      </td>

      <td className="py-2.5 px-3">
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={() => onTrade(token)}
            className="px-2.5 py-1 rounded-lg bg-brand-500/15 border border-brand-500/30 text-brand-400 hover:bg-brand-500 hover:text-white text-[11px] font-bold flex items-center gap-0.5 transition-colors cursor-pointer"
          >
            Trade <ArrowUpRight className="w-3 h-3" />
          </button>

          {canBlock && (
            <button
              onClick={() => onToggleBlock(token, isBlocked)}
              title={isBlocked ? "Unblock token" : "Block token"}
              className={classNames(
                "p-1.5 rounded-lg border transition-colors cursor-pointer",
                isBlocked
                  ? "bg-success-500/10 border-success-500/30 text-success-400"
                  : "border-card-border text-muted-text hover:text-danger-400 hover:border-danger-500/30"
              )}
            >
              {isBlocked ? <Unlock className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
});
