import type { ChainId } from "../../types/chain.js";

/** Bucket width for the stored candles. Every UI window derives from these. */
export const BUCKET_MS = 5 * 60 * 1000;

/** Floors a timestamp to its 5-minute bucket boundary. */
export function bucketStartOf(timestamp: number): Date {
  return new Date(Math.floor(timestamp / BUCKET_MS) * BUCKET_MS);
}

/** A pool we ingest swaps from, as the indexer needs it in memory. */
export interface TrackedPool {
  id: number;
  chainId: ChainId;
  dexId: string;
  poolAddress: string;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  feeTier: number | null;
}

/**
 * One decoded swap, normalised away from any chain's log format.
 *
 * Amounts are signed from the *pool's* perspective — positive means the token
 * flowed into the pool. That sign is what distinguishes a buy from a sell, so
 * it is preserved rather than absolute-valued at decode time.
 */
export interface DecodedSwap {
  poolId: number;
  blockNumber: bigint;
  /** Position within the block; used only to order swaps deterministically. */
  logIndex: number;
  timestamp: number;
  amount0: bigint;
  amount1: bigint;
  /** Price of token0 denominated in token1, decimal-adjusted. */
  price0In1: number;
}

/** An in-progress 5-minute bucket for one pool. */
export interface CandleBucket {
  poolId: number;
  bucketStart: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
  buys: number;
  sells: number;
}

/**
 * Per-chain ingestion.
 *
 * One implementation per *execution shape* rather than per chain: every
 * Uniswap-V3-family deployment emits identical `Swap` logs, so a single EVM
 * indexer serves Ethereum, Base, Celo and Robinhood. Solana and Stacks need
 * genuinely different ingestion and would each add an implementation here.
 */
export interface ChainIndexer {
  readonly chainId: ChainId;
  /**
   * Discovers new pools and ingests swaps up to a reorg-safe height.
   * Returns what it did, for logging and for the cycle summary.
   */
  run(): Promise<IndexRunResult>;
}

export interface IndexRunResult {
  chainId: ChainId;
  poolsDiscovered: number;
  swapsIngested: number;
  bucketsWritten: number;
  fromBlock: bigint;
  toBlock: bigint;
}
