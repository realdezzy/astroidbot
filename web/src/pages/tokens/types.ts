/** A row in the discovery table, as `/api/tokens` returns it. */
export interface DexToken {
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
  chainId: string;
  chainName: string;
  dexId: string;
  icon?: string;
  /**
   * Every metric is nullable. The API distinguishes "we measured zero" from
   * "we have no data", and the table must render those differently — a dash
   * and a zero mean opposite things in a sortable column.
   */
  priceUsd: number | null;
  priceChange: {
    m5: number | null;
    h1: number | null;
    h6: number | null;
    h24: number | null;
  };
  volume24h: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  txns24h: { buys: number | null; sells: number | null };
  pairCreatedAt?: number | null;
  isVerified: boolean;
  explorerUrl?: string | null;
}

export interface TokensResponse {
  tokens: DexToken[];
  total: number;
  page: number;
  pageSize: number;
  /** Which provider answered — surfaced so the UI can label DEX-derived data. */
  source?: string;
}

export interface ChainInfo {
  chainId: string;
  family: string;
  displayName: string;
  nativeSymbol: string;
  isTestnet: boolean;
  tradable: boolean;
}

export type Timeframe = "m5" | "h1" | "h6" | "h24";
export type Category = "trending" | "gainers" | "new" | "all" | "blocked";
export type SortField = "volume" | "change" | "liquidity" | "mcap" | "symbol";
