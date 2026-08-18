import { parseAbiItem } from "viem";
import type { ChainId } from "../../../types/chain.js";
import type { SwapEvent, PoolCreatedEvent } from "../events/canonical.js";
import type { DexAdapter } from "./dexAdapter.js";
import type { TrackedPool } from "../types.js";
import { priceFromSqrtX96 } from "../priceMath.js";

const POOL_CREATED_EVENT = parseAbiItem(
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
);

const SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
);

export class UniswapV3Adapter implements DexAdapter {
  readonly dexId = "uniswap-v3";
  readonly chainFamily = "evm";

  canHandle(dexId: string, chainId: ChainId): boolean {
    return dexId.toLowerCase().includes("uniswap-v3") || dexId.toLowerCase().includes("pancakeswap-v3");
  }

  decodePoolCreated(rawLog: unknown, chainId: ChainId): PoolCreatedEvent | null {
    const log = rawLog as {
      args?: { token0?: string; token1?: string; fee?: bigint | number; pool?: string };
      blockNumber?: bigint;
    };
    if (!log?.args?.token0 || !log.args.token1 || !log.args.pool) return null;

    return {
      chainId,
      dexId: this.dexId,
      poolAddress: log.args.pool.toLowerCase(),
      token0: log.args.token0.toLowerCase(),
      token1: log.args.token1.toLowerCase(),
      feeTier: log.args.fee != null ? Number(log.args.fee) : null,
      createdBlock: log.blockNumber ?? 0n,
      timestamp: Date.now(),
    };
  }

  decodeSwap(pool: TrackedPool, rawLog: unknown): SwapEvent | null {
    const log = rawLog as {
      args?: {
        amount0?: bigint;
        amount1?: bigint;
        sqrtPriceX96?: bigint;
        recipient?: string;
        sender?: string;
      };
      transactionHash?: string;
      blockNumber?: bigint;
      logIndex?: number;
    };

    if (
      !log?.args ||
      log.args.amount0 === undefined ||
      log.args.amount1 === undefined ||
      log.args.sqrtPriceX96 === undefined
    ) {
      return null;
    }

    const { amount0, amount1, sqrtPriceX96, recipient, sender } = log.args;
    const traderAddress = (recipient ?? sender ?? "").toLowerCase();
    const price0In1 = priceFromSqrtX96(sqrtPriceX96, pool.decimals0, pool.decimals1);
    const txHash = log.transactionHash ?? "";
    const logIndex = log.logIndex ?? 0;

    const isBuyToken0 = amount0 < 0n;

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
      amountIn: isBuyToken0 ? (amount1 < 0n ? -amount1 : amount1) : (amount0 < 0n ? -amount0 : amount0),
      amountOut: isBuyToken0 ? (amount0 < 0n ? -amount0 : amount0) : (amount1 < 0n ? -amount1 : amount1),
      price0In1,
    };
  }
}
