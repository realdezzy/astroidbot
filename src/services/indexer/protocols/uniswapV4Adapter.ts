import { parseAbiItem } from "viem";
import type { ChainId } from "../../../types/chain.js";
import type { TrackedPool } from "../types.js";
import { UniswapV3Adapter } from "./uniswapV3Adapter.js";
import type { DexAdapter } from "./dexAdapter.js";

export const V4_INITIALIZE = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
export const V4_SWAP = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
export type V4PoolKey = { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };

export class UniswapV4Adapter implements DexAdapter {
  readonly dexId = "uniswap-v4";
  readonly chainFamily = "evm";
  private v3 = new UniswapV3Adapter();
  canHandle(dexId: string, _chainId: ChainId) { return dexId === this.dexId; }
  decodePoolCreated(raw: unknown, chainId: ChainId) {
    const log = raw as { address?: string; blockNumber?: bigint; args?: V4PoolKey & { id?: string } };
    const args = log.args;
    if (!log.address || !args?.id || !args.currency0 || !args.currency1 || !args.hooks) return null;
    return { chainId, dexId: this.dexId, poolAddress: `${log.address}:${args.id}`.toLowerCase(),
      token0: args.currency0.toLowerCase(), token1: args.currency1.toLowerCase(), feeTier: Number(args.fee),
      createdBlock: log.blockNumber ?? 0n, timestamp: 0,
      protocolState: { key: { currency0: args.currency0, currency1: args.currency1, fee: Number(args.fee), tickSpacing: Number(args.tickSpacing), hooks: args.hooks } },
    };
  }
  decodeSwap(pool: TrackedPool, raw: unknown) {
    const log = raw as { args?: { amount0?: bigint; amount1?: bigint } };
    if (log.args?.amount0 == null || log.args.amount1 == null) return null;
    // V4 BalanceDelta describes the caller: input is negative, output positive.
    return this.v3.decodeSwap(pool, { ...log, args: { ...log.args, amount0: -log.args.amount0, amount1: -log.args.amount1 } });
  }
}
