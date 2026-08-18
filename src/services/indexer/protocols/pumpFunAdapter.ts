import type { ChainId } from "../../../types/chain.js";
import type { SwapEvent, PoolCreatedEvent } from "../events/canonical.js";
import type { DexAdapter } from "./dexAdapter.js";
import type { TrackedPool } from "../types.js";
import { toHuman } from "../priceMath.js";

export const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export class PumpFunAdapter implements DexAdapter {
  readonly dexId = "pumpfun";
  readonly chainFamily = "svm";

  canHandle(dexId: string, chainId: ChainId): boolean {
    return chainId === "solana:mainnet" && dexId.toLowerCase().includes("pump");
  }

  decodePoolCreated(): PoolCreatedEvent | null {
    return null;
  }

  decodeSwap(pool: TrackedPool, rawPayload: unknown): SwapEvent | null {
    const swap = rawPayload as {
      signature?: string;
      slot?: bigint;
      timestamp?: number;
      solAmount?: bigint;
      tokenAmount?: bigint;
      isBuy?: boolean;
      trader?: string;
    };

    if (!swap?.signature || swap.solAmount === undefined || swap.tokenAmount === undefined) {
      return null;
    }

    const isBuy = swap.isBuy ?? true;
    const solAmountHuman = toHuman(swap.solAmount, 9);
    const tokenAmountHuman = toHuman(swap.tokenAmount, pool.decimals0);
    const price0In1 = tokenAmountHuman > 0 ? solAmountHuman / tokenAmountHuman : 0;

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
      tokenIn: isBuy ? pool.token1 : pool.token0,
      tokenOut: isBuy ? pool.token0 : pool.token1,
      amountIn: isBuy ? swap.solAmount : swap.tokenAmount,
      amountOut: isBuy ? swap.tokenAmount : swap.solAmount,
      price0In1,
    };
  }
}
