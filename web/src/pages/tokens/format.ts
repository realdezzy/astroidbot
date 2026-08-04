/**
 * Formatting for the discovery table.
 *
 * Split out because the table is dense enough that these run thousands of
 * times per render, and because "how a price is written" is a product decision
 * that shows up in three places (table, detail page, trade panel).
 */

/**
 * Prices spanning memecoin dust to BTC in one column.
 *
 * Below 0.001 the significant digits are pushed past where a fixed decimal
 * count can show them, so we switch to DexScreener's subscript notation:
 * $0.0₅9419 means five zeros then 9419. Rendering that as $0.00 — which any
 * fixed precision does — makes every dust token look identically worthless.
 */
export function formatPrice(price: number | null | undefined): string {
  if (price == null || !Number.isFinite(price) || price === 0) return "—";
  if (price < 0) return "—";

  if (price >= 1) {
    return `$${price.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  if (price >= 0.001) {
    return `$${price.toFixed(price >= 0.01 ? 4 : 5)}`;
  }

  // Count leading zeros after the decimal point.
  const exponent = Math.floor(Math.log10(price));
  const leadingZeros = -exponent - 1;
  const digits = Math.round(price * 10 ** (leadingZeros + 4));

  return `$0.0${toSubscript(leadingZeros)}${digits}`;
}

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";

function toSubscript(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUBSCRIPTS[Number(d)] ?? d)
    .join("");
}

/** Compact USD for the mcap / volume / liquidity columns. */
export function formatUsdCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";

  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${Math.round(value / 1e3)}K`;
  return `$${value.toFixed(0)}`;
}

/** Plain integer with separators; "—" when we have no count at all. */
export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString();
}

/**
 * Age of a pair, in the largest unit that stays readable.
 *
 * Returns "—" rather than a made-up default when we don't know: an unknown
 * creation time is common for tokens we've only just started indexing, and
 * showing "1d" for those is a quiet lie in a column people sort by.
 */
export function formatAge(timestamp: number | null | undefined): string {
  if (timestamp == null || !Number.isFinite(timestamp)) return "—";

  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) return "—";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;

  return `${Math.floor(months / 12)}y`;
}

/** Signed percentage, or "—" when the window has no data behind it. */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";

  const abs = Math.abs(value);
  // Big moves don't need decimals and they'd blow out the column width.
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : 2;
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}
