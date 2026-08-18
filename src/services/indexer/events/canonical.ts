import type { ChainId } from "../../../types/chain.js";

export interface SwapEvent {
  chainId: ChainId;
  dexId: string;
  poolId: number;
  poolAddress: string;
  txKey: string;
  txHash: string;
  blockNumber: bigint;
  logIndex: number;
  timestamp: number;
  traderAddress?: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  price0In1: number;
  priceNative?: number;
  priceUsd?: number;
}

export interface PoolCreatedEvent {
  chainId: ChainId;
  dexId: string;
  poolAddress: string;
  token0: string;
  token1: string;
  feeTier: number | null;
  createdBlock: bigint;
  timestamp?: number;
}

export interface LiquidityEvent {
  chainId: ChainId;
  dexId: string;
  poolAddress: string;
  txKey: string;
  blockNumber: bigint;
  logIndex: number;
  timestamp: number;
  providerAddress?: string;
  isAdd: boolean;
  amount0: bigint;
  amount1: bigint;
  liquidityUsd?: number;
}

export interface TokenCreatedEvent {
  chainId: ChainId;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  totalSupply?: bigint;
  createdBlock?: bigint;
}
