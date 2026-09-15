import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { DatabaseService } from "../../db.js";
import { priceFromSqrtX96, toHuman } from "../priceMath.js";
import type { TrackedPool } from "../types.js";
import type { V4PoolKey } from "../protocols/uniswapV4Adapter.js";

const LENS = "0x0000001b173C3bbF3984D417d8614E3eed34865B" as Address;
const RESERVES = parseAbiItem("function getPoolTVLPaged(address manager, (address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, bytes cursor) view returns ((uint256 coreAmount0,uint256 coreAmount1,uint256 hookReserves0,uint256 hookReserves1,uint256 hookEffective0,uint256 hookEffective1,uint160 sqrtPriceX96,int24 tick,uint128 activeLiquidity,uint256 blockNumber,address statsProvider,uint16 hookPermissions,bool hasCustomAccounting,uint8 statsStatus) result, bytes nextCursor, bool done)");

/** Paged lens reads at one explicit block; a partial reserve sum is never published. */
export async function refreshV4Liquidity(pool: TrackedPool, rpc: PublicClient, usd: Map<string, number>, blockNumber: bigint): Promise<void> {
  const db = DatabaseService.getInstance().prisma;
  const row = await db.indexedPool.findUnique({ where: { id: pool.id } });
  const state = row?.protocolState as { key?: V4PoolKey; scan?: { cursor: string; block: string } } | null;
  if (!state?.key) throw new Error(`V4 pool key missing for ${pool.poolAddress}`);
  const manager = pool.poolAddress.split(":")[0] as Address;
  const key = state.key as { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  let cursor = (state.scan?.cursor ?? "0x") as Hex;
  const at = state.scan ? BigInt(state.scan.block) : blockNumber;
  for (let page = 0; page < 4; page++) {
    const [result, nextCursor, done] = await rpc.readContract({ address: LENS, abi: [RESERVES], functionName: "getPoolTVLPaged", args: [manager, key, cursor], blockNumber: at }).catch(async (error: unknown) => {
      // A reorg or an unavailable historical state invalidates the continuation.
      await db.indexedPool.update({ where: { id: pool.id }, data: { protocolState: { key: state.key! } } });
      throw error;
    });
    cursor = nextCursor;
    if (done) {
      const ratio = priceFromSqrtX96(result.sqrtPriceX96, pool.decimals0, pool.decimals1);
      const p0 = usd.get(pool.token0) ?? (usd.has(pool.token1) ? ratio * usd.get(pool.token1)! : undefined);
      const p1 = usd.get(pool.token1) ?? (usd.has(pool.token0) && ratio > 0 ? usd.get(pool.token0)! / ratio : undefined);
      // Hook assets are self-reported and kept out of core-derived liquidity.
      const liquidityUsd = p0 != null && p1 != null
        ? toHuman(result.coreAmount0, pool.decimals0) * p0 + toHuman(result.coreAmount1, pool.decimals1) * p1 : null;
      await db.indexedPool.update({ where: { id: pool.id }, data: {
        protocolState: { key: state.key }, liquidityUsd: liquidityUsd != null && Number.isFinite(liquidityUsd) ? liquidityUsd : null,
      } });
      return;
    }
  }
  await db.indexedPool.update({ where: { id: pool.id }, data: { protocolState: { key: state.key, scan: { cursor, block: at.toString() } } } });
}
