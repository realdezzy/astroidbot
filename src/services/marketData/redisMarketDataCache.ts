import { RedisService } from "../redis.js";
import type { PoolState } from "../indexer/state/poolStateEngine.js";

const HOT_PAIR_TTL_SECONDS = 24 * 60 * 60; // 24 Hours TTL Eviction for inactive pairs

export class RedisMarketDataCache {
  private static instance: RedisMarketDataCache;

  static getInstance(): RedisMarketDataCache {
    if (!RedisMarketDataCache.instance) {
      RedisMarketDataCache.instance = new RedisMarketDataCache();
    }
    return RedisMarketDataCache.instance;
  }

  private pairKey(chainId: string, poolAddress: string): string {
    return `market:pair:${chainId}:${poolAddress.toLowerCase()}`;
  }

  private rankingsKey(chainId: string): string {
    return `market:rankings:${chainId}:volume24h`;
  }

  async getPairState(chainId: string, poolAddress: string): Promise<PoolState | null> {
    const redis = RedisService.getInstance();
    const raw = await redis.get(this.pairKey(chainId, poolAddress));
    if (!raw) return null;

    try {
      return JSON.parse(raw) as PoolState;
    } catch {
      return null;
    }
  }

  async cachePairState(state: PoolState): Promise<void> {
    const redis = RedisService.getInstance();
    const key = this.pairKey(state.chainId, state.poolAddress);

    await redis.set(key, JSON.stringify(state), HOT_PAIR_TTL_SECONDS);
  }

  async invalidatePairState(chainId: string, poolAddress: string): Promise<void> {
    const redis = RedisService.getInstance();
    await redis.del(this.pairKey(chainId, poolAddress));
  }
}
