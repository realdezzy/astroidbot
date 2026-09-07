import type { ChainId } from "../../../types/chain.js";
import type { SwapEvent, PoolCreatedEvent } from "../events/canonical.js";
import type { DexAdapter } from "./dexAdapter.js";
import type { TrackedPool } from "../types.js";

export class UniswapV2Adapter implements DexAdapter {
  readonly dexId = "uniswap-v2";
  readonly chainFamily = "evm";

  canHandle(dexId: string, _chainId: ChainId): boolean {
    const id = dexId.toLowerCase();
    return id.includes("uniswap-v2") || id.includes("pancakeswap-v2") || id.includes("sushiswap");
  }

  decodePoolCreated(rawLog: unknown, chainId: ChainId): PoolCreatedEvent | null {
    const log = rawLog as {
      args?: { token0?: string; token1?: string; pair?: string };
      blockNumber?: bigint;
    };
    if (!log?.args?.token0 || !log.args.token1 || !log.args.pair) return null;

    return {
      chainId,
      dexId: this.dexId,
      poolAddress: log.args.pair.toLowerCase(),
      token0: log.args.token0.toLowerCase(),
      token1: log.args.token1.toLowerCase(),
      feeTier: 3000, // Fixed 30 bps (0.30%) fee for V2 pools
      createdBlock: log.blockNumber ?? 0n,
      timestamp: Date.now(),
    };
  }

  decodeSwap(pool: TrackedPool, rawLog: unknown): SwapEvent | null {
    const log = rawLog as {
      args?: {
        sender?: string;
        amount0In?: bigint;
        amount1In?: bigint;
        amount0Out?: bigint;
        amount1Out?: bigint;
        to?: string;
      };
      transactionHash?: string;
      blockNumber?: bigint;
      logIndex?: number;
    };

    if (
      !log?.args ||
      log.args.amount0In === undefined ||
      log.args.amount1In === undefined ||
      log.args.amount0Out === undefined ||
      log.args.amount1Out === undefined
    ) {
      return null;
    }

    const { sender, amount0In, amount1In, amount0Out, amount1Out, to } = log.args;
    const traderAddress = (to ?? sender ?? "").toLowerCase();
    const txHash = log.transactionHash ?? "";
    const logIndex = log.logIndex ?? 0;

    const isBuyToken0 = amount0Out > 0n;
    const amountIn = isBuyToken0 ? amount1In : amount0In;
    const amountOut = isBuyToken0 ? amount0Out : amount1Out;

    if (amountIn <= 0n || amountOut <= 0n) return null;

    const price0In1 =
      amountOut > 0n && amountIn > 0n
        ? Number(amount1In > 0n ? amount1In : amount1Out) /
          Number(amount0In > 0n ? amount0In : amount0Out)
        : 0;

    return {
      chainId: pool.chainId,
      dexId: pool.dexId,
      poolId: pool.id,
      poolAddress: pool.poolAddress.toLowerCase(),
      txKey: `${txHash}:${logIndex}`,
      txHash,
      blockNumber: log.blockNumber ?? 0n,
      logIndex,
      timestamp: Date.now(),
      traderAddress: traderAddress || undefined,
      tokenIn: isBuyToken0 ? pool.token1 : pool.token0,
      tokenOut: isBuyToken0 ? pool.token0 : pool.token1,
      amountIn,
      amountOut,
      price0In1,
    };
  }
}
