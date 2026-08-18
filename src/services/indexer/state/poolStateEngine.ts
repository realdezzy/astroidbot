import type { SwapEvent } from "../events/canonical.js";
import type { TrackedPool } from "../types.js";

export interface PoolState {
  poolId: number;
  chainId: string;
  dexId: string;
  poolAddress: string;
  token0: string;
  token1: string;
  price0In1: number;
  reserve0?: bigint;
  reserve1?: bigint;
  liquidityUsd?: number;
  volume24hUsd: number;
  txns24h: number;
  lastTradedAt: Date;
  updatedAt: Date;
}

export class PoolStateEngine {
  private static instance: PoolStateEngine;
  private poolStates = new Map<string, PoolState>();

  static getInstance(): PoolStateEngine {
    if (!PoolStateEngine.instance) {
      PoolStateEngine.instance = new PoolStateEngine();
    }
    return PoolStateEngine.instance;
  }

  private stateKey(chainId: string, poolAddress: string): string {
    return `${chainId}:${poolAddress.toLowerCase()}`;
  }

  getPoolState(chainId: string, poolAddress: string): PoolState | undefined {
    return this.poolStates.get(this.stateKey(chainId, poolAddress));
  }

  initPoolState(pool: TrackedPool): PoolState {
    const key = this.stateKey(pool.chainId, pool.poolAddress);
    let state = this.poolStates.get(key);
    if (!state) {
      state = {
        poolId: pool.id,
        chainId: pool.chainId,
        dexId: pool.dexId,
        poolAddress: pool.poolAddress.toLowerCase(),
        token0: pool.token0,
        token1: pool.token1,
        price0In1: 0,
        volume24hUsd: 0,
        txns24h: 0,
        lastTradedAt: new Date(),
        updatedAt: new Date(),
      };
      this.poolStates.set(key, state);
    }
    return state;
  }

  processSwap(swap: SwapEvent, pool: TrackedPool): PoolState {
    const state = this.initPoolState(pool);

    state.price0In1 = swap.price0In1;
    state.volume24hUsd += swap.priceUsd ? swap.priceUsd * (Number(swap.amountIn) / 10 ** pool.decimals0) : 0;
    state.txns24h += 1;
    state.lastTradedAt = new Date(swap.timestamp);
    state.updatedAt = new Date();

    return state;
  }

  clear(): void {
    this.poolStates.clear();
  }
}
