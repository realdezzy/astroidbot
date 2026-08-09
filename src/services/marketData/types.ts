import type { ChainId } from "../../types/chain.js";

/**
 * Market metrics for one token, in the shape the discovery UI renders.
 *
 * Every numeric field is nullable on purpose. A provider that genuinely does
 * not know a value must say so rather than substitute zero: "$0 volume" and
 * "no volume data" look identical in a table but mean opposite things, and the
 * sort order silently buries the second one.
 */
export interface TokenMarketData {
  chainId: ChainId;
  contractId: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  logoUrl?: string | null;
  /** Which venue the quote came from ("uniswap-v3", "jupiter", …). */
  dexId?: string | null;

  priceUsd: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange6h: number | null;
  priceChange24h: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  txnsBuys24h: number | null;
  txnsSells24h: number | null;
  /** When the token's deepest pair was created — the UI's "age" column. */
  pairCreatedAt: Date | null;
}

/**
 * A source of token market data.
 *
 * Two implementations exist and they are not peers: `internal` reads our own
 * swap-event index and is what production runs on; `dexscreener` calls a
 * third-party API and exists to exercise this interface during development.
 * Keeping both behind one type is what makes the switch a config change rather
 * than a rewrite of every discovery call site.
 */
export interface MarketDataProvider {
  readonly name: string;

  /**
   * Whether this provider can say anything about a chain at all. The internal
   * provider answers for chains it indexes; DexScreener answers for chains it
   * lists. A caller that ignores this gets empty results rather than errors,
   * but loses the ability to fall back.
   */
  supportsChain(chainId: ChainId): boolean;

  /**
   * Metrics for specific tokens, keyed by lowercased contractId.
   *
   * Batched rather than per-token because both backends are far cheaper per
   * call than per token — one API request or one grouped query serves the
   * whole page.
   */
  getMarketData(
    chainId: ChainId,
    contractIds: string[]
  ): Promise<Map<string, TokenMarketData>>;

  /**
   * Free-text search across symbol / name / address.
   *
   * Scoped to one chain when `chainId` is given. Used for the discovery
   * search box, where the query may name a token we have never catalogued.
   */
  search(query: string, chainId?: ChainId): Promise<TokenMarketData[]>;

  /**
   * The most active tokens on a chain, for the default (unsearched) listing.
   * Providers that cannot rank return an empty array and the caller falls back
   * to the catalogue's own ordering.
   */
  topTokens?(chainId: ChainId, limit: number): Promise<TokenMarketData[]>;
}
