import { useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Info } from "lucide-react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { classNames, formatNumber } from "../lib/utils";
import { ChainBadge } from "../components/ChainBadge";

interface TokenDetailData {
  chainId: string;
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUsd: number | null;
  priceChange24h: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  isVerified: boolean;
  tradable: boolean;
  chain: {
    chainId: string;
    displayName: string;
    nativeSymbol: string;
    stableSymbol: string;
    explorerUrl: string;
  } | null;
}

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string;
}

const TIMEFRAMES = ["1h", "4h", "1d"] as const;

/** Public token detail with a Trade action that deep-links into the trade form. */
export function TokenDetail() {
  const { chainId = "", contractId = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [timeframe, setTimeframe] = useState<string>("1h");

  const { data: token, isLoading, error } = useQuery<TokenDetailData>({
    queryKey: ["token-detail", chainId, contractId],
    queryFn: () =>
      apiFetch(`/tokens/${encodeURIComponent(chainId)}/${encodeURIComponent(contractId)}`),
  });

  const { data: candleData } = useQuery<{ candles: Candle[] }>({
    queryKey: ["token-candles", chainId, contractId, timeframe],
    queryFn: () =>
      apiFetch(
        `/tokens/${encodeURIComponent(chainId)}/${encodeURIComponent(contractId)}/candles?timeframe=${timeframe}`
      ),
    enabled: !!token,
  });

  if (isLoading) {
    return <div className="p-10 text-center text-muted-text">Loading…</div>;
  }

  if (error || !token) {
    return (
      <div className="p-10 text-center">
        <p className="text-muted-text">That token isn&apos;t in the catalogue.</p>
        <Link to="/tokens" className="mt-4 inline-block text-brand-400 hover:underline">
          Back to tokens
        </Link>
      </div>
    );
  }

  const tradeTarget = `/trade?${new URLSearchParams({
    chainId: token.chainId,
    tokenOut: token.symbol,
  })}`;
  // Preserve the choice through login rather than dropping the user on an
  // empty trade form.
  const tradeHref = user ? tradeTarget : `/login?redirect=${encodeURIComponent(tradeTarget)}`;

  const candles = candleData?.candles ?? [];
  const sparkPath = buildSparkline(candles);

  return (
    <div className="min-h-screen bg-page-bg px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <Link
          to="/tokens"
          className="mb-6 inline-flex items-center gap-2 text-sm text-muted-text hover:text-title-text"
        >
          <ArrowLeft className="h-4 w-4" /> All tokens
        </Link>

        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold text-title-text">{token.symbol}</h1>
              <ChainBadge chainId={token.chainId} />
            </div>
            <p className="mt-1 text-muted-text">{token.name}</p>
          </div>

          <div className="text-right">
            <div className="text-2xl font-bold text-title-text">
              {token.priceUsd != null ? `$${formatNumber(token.priceUsd)}` : "—"}
            </div>
            {token.priceChange24h != null && (
              <div
                className={classNames(
                  "text-sm",
                  token.priceChange24h >= 0 ? "text-emerald-400" : "text-red-400"
                )}
              >
                {token.priceChange24h >= 0 ? "+" : ""}
                {token.priceChange24h.toFixed(2)}% 24h
              </div>
            )}
          </div>
        </div>

        {/* Trade is the primary action — this page exists to lead here. It is
            hidden entirely when the chain has no router, rather than shown as
            a button that cannot work. */}
        {token.tradable ? (
          <button
            onClick={() => navigate(tradeHref)}
            className="mb-8 w-full rounded-xl bg-brand-400 py-3 text-base font-semibold text-black hover:bg-brand-300"
          >
            Trade {token.symbol}
          </button>
        ) : (
          <div className="mb-8 rounded-xl border border-border-color bg-card-bg px-4 py-3 text-sm text-muted-text">
            No DEX is available for {token.chain?.displayName ?? token.chainId} yet, so this
            token can be tracked but not traded.
          </div>
        )}

        <div className="mb-8 rounded-xl border border-border-color bg-card-bg p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-title-text">Price</h2>
            <div className="flex gap-1">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  onClick={() => setTimeframe(tf)}
                  className={classNames(
                    "rounded px-2.5 py-1 text-xs",
                    timeframe === tf
                      ? "bg-brand-400 text-black"
                      : "text-muted-text hover:text-title-text"
                  )}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>

          {sparkPath ? (
            <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-32 w-full">
              <path d={sparkPath} fill="none" stroke="currentColor" strokeWidth="0.6"
                className="text-brand-400" vectorEffect="non-scaling-stroke" />
            </svg>
          ) : (
            <p className="py-10 text-center text-sm text-muted-text">
              No price history recorded yet.
            </p>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Volume 24h" value={token.volume24h} prefix="$" />
          <Stat label="Liquidity" value={token.liquidityUsd} prefix="$" />
          <Stat label="Market cap" value={token.marketCapUsd} prefix="$" />
          <div className="rounded-xl border border-border-color bg-card-bg p-4">
            <dt className="text-xs uppercase text-muted-text">Decimals</dt>
            <dd className="mt-1 text-lg font-semibold text-title-text">{token.decimals}</dd>
          </div>
        </dl>

        <div className="mt-6 rounded-xl border border-border-color bg-card-bg p-5">
          <h2 className="mb-2 font-semibold text-title-text">Contract</h2>
          <p className="break-all font-mono text-xs text-muted-text">{token.contractId}</p>
          {token.chain && (
            <a
              href={token.chain.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1 text-sm text-brand-400 hover:underline"
            >
              View on explorer <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

        <p className="mt-6 flex items-start gap-2 text-xs text-muted-text">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Price is derived from on-chain DEX quotes, not a market-data provider.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, prefix = "" }: { label: string; value: number | null; prefix?: string }) {
  return (
    <div className="rounded-xl border border-border-color bg-card-bg p-4">
      <dt className="text-xs uppercase text-muted-text">{label}</dt>
      <dd className="mt-1 text-lg font-semibold text-title-text">
        {value != null ? `${prefix}${formatNumber(value)}` : "—"}
      </dd>
    </div>
  );
}

/** Minimal inline sparkline — avoids pulling a chart library into a public page. */
function buildSparkline(candles: Candle[]): string | null {
  if (candles.length < 2) return null;

  const closes = candles.map((c) => c.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;

  return closes
    .map((close, i) => {
      const x = (i / (closes.length - 1)) * 100;
      const y = 30 - ((close - min) / range) * 28 - 1;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}
