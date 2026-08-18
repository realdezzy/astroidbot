import { DatabaseService } from "../../db.js";
import type { ChainId } from "../../../types/chain.js";
import { PoolLifecycleEngine, type PoolLifecycleState } from "./poolLifecycle.js";

export class PoolDiscoveryService {
  private static instance: PoolDiscoveryService;

  static getInstance(): PoolDiscoveryService {
    if (!PoolDiscoveryService.instance) {
      PoolDiscoveryService.instance = new PoolDiscoveryService();
    }
    return PoolDiscoveryService.instance;
  }

  async getActivePools(chainId: ChainId): Promise<{ poolAddress: string; dexId: string }[]> {
    const db = DatabaseService.getInstance();
    const rows = await db.prisma.indexedPool.findMany({
      where: { chainId, lifecycleState: "ACTIVE" },
      select: { poolAddress: true, dexId: true },
    });
    return rows;
  }

  async updatePoolLifecycles(chainId: ChainId): Promise<number> {
    const db = DatabaseService.getInstance();
    const pools = await db.prisma.indexedPool.findMany({
      where: { chainId },
      select: { id: true, liquidityUsd: true, lastSwapAt: true, createdAt: true, lifecycleState: true },
    });

    let updatedCount = 0;
    for (const pool of pools) {
      const newState: PoolLifecycleState = PoolLifecycleEngine.evaluateState({
        liquidityUsd: pool.liquidityUsd,
        lastSwapAt: pool.lastSwapAt,
        createdAt: pool.createdAt,
      });

      if (newState !== pool.lifecycleState) {
        await db.prisma.indexedPool.update({
          where: { id: pool.id },
          data: { lifecycleState: newState },
        });
        updatedCount++;
      }
    }

    return updatedCount;
  }
}
