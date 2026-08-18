import type { ChainId } from "../../../types/chain.js";
import type { SwapEvent, PoolCreatedEvent } from "../events/canonical.js";
import type { DexAdapter } from "./dexAdapter.js";
import type { TrackedPool } from "../types.js";
import { toHuman } from "../priceMath.js";

export const RAYDIUM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const RAYDIUM_CLMM_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const RAYDIUM_CPMM_PROGRAM_ID = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";

export class RaydiumAdapter implements DexAdapter {
  readonly dexId = "raydium";
  readonly chainFamily = "svm";

  canHandle(dexId: string, chainId: ChainId): boolean {
    return chainId === "solana:mainnet" && dexId.toLowerCase().includes("raydium");
  }

  decodePoolCreated(): PoolCreatedEvent | null {
    return null;
  }

  decodeSwap(pool: TrackedPool, rawPayload: unknown): SwapEvent | null {
    const swap = rawPayload as {
      signature?: string;
      slot?: bigint;
      timestamp?: number;
      amount0?: bigint;
      amount1?: bigint;
      trader?: string;
    };

    if (!swap?.signature || swap.amount0 === undefined || swap.amount1 === undefined) {
      return null;
    }

    const amount0Human = toHuman(swap.amount0 < 0n ? -swap.amount0 : swap.amount0, pool.decimals0);
    const amount1Human = toHuman(swap.amount1 < 0n ? -swap.amount1 : swap.amount1, pool.decimals1);
    const price0In1 = amount0Human > 0 ? amount1Human / amount0Human : 0;
    const isBuyToken0 = swap.amount0 > 0n;

    return {
      chainId: pool.chainId,
      dexId: this.dexId,
      poolId: pool.id,
      poolAddress: pool.poolAddress,
      txKey: swap.signature,
      txHash: swap.signature,
      blockNumber: swap.slot ?? 0n,
      logIndex: 0,
      timestamp: swap.timestamp ?? Date.now(),
      traderAddress: swap.trader,
      tokenIn: isBuyToken0 ? pool.token1 : pool.token0,
      tokenOut: isBuyToken0 ? pool.token0 : pool.token1,
      amountIn: isBuyToken0 ? (swap.amount1 < 0n ? -swap.amount1 : swap.amount1) : (swap.amount0 < 0n ? -swap.amount0 : swap.amount0),
      amountOut: isBuyToken0 ? (swap.amount0 < 0n ? -swap.amount0 : swap.amount0) : (swap.amount1 < 0n ? -swap.amount1 : swap.amount1),
      price0In1,
    };
  }
}
