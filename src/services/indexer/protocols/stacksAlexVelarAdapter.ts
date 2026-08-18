import type { ChainId } from "../../../types/chain.js";
import type { SwapEvent, PoolCreatedEvent } from "../events/canonical.js";
import type { DexAdapter } from "./dexAdapter.js";
import type { TrackedPool } from "../types.js";
import { decodeStacksSwapPrint } from "../stacks/printDecoder.js";
import { toHuman } from "../priceMath.js";

export class StacksAlexVelarAdapter implements DexAdapter {
  readonly dexId = "stacks-alex-velar";
  readonly chainFamily = "stacks";

  canHandle(dexId: string, chainId: ChainId): boolean {
    const d = dexId.toLowerCase();
    return chainId === "stacks:mainnet" && (d.includes("alex") || d.includes("velar"));
  }

  decodePoolCreated(): PoolCreatedEvent | null {
    return null;
  }

  decodeSwap(pool: TrackedPool, rawLog: unknown): SwapEvent | null {
    const log = rawLog as {
      repr?: string;
      dexId?: string;
      txId?: string;
      eventIndex?: number;
      blockHeight?: bigint;
      sender?: string;
    };

    if (!log?.repr || !log.dexId) return null;
    const decoded = decodeStacksSwapPrint(log.repr, log.dexId);
    if (!decoded) return null;

    const amount0Human = toHuman(decoded.amount0, pool.decimals0);
    const amount1Human = toHuman(decoded.amount1, pool.decimals1);
    const price0In1 = amount0Human > 0 ? amount1Human / amount0Human : 0;
    const txHash = log.txId ?? "";
    const logIndex = log.eventIndex ?? 0;

    return {
      chainId: pool.chainId,
      dexId: log.dexId,
      poolId: pool.id,
      poolAddress: pool.poolAddress,
      txKey: `${txHash}:${logIndex}`,
      txHash,
      blockNumber: log.blockHeight ?? 0n,
      logIndex,
      timestamp: Date.now(),
      traderAddress: log.sender,
      tokenIn: decoded.zeroForOne ? pool.token0 : pool.token1,
      tokenOut: decoded.zeroForOne ? pool.token1 : pool.token0,
      amountIn: decoded.zeroForOne ? decoded.amount0 : decoded.amount1,
      amountOut: decoded.zeroForOne ? decoded.amount1 : decoded.amount0,
      price0In1,
    };
  }
}
