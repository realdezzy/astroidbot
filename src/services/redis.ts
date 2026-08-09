import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { ConfigManager } from "../config.js";
import { logger } from "../utils/logger.js";

export class RedisService {
  private static instance: RedisService;
  private client: Redis | null = null;

  private constructor() {}

  static getInstance(): RedisService {
    if (!RedisService.instance) {
      RedisService.instance = new RedisService();
    }
    return RedisService.instance;
  }

  private getClient(): Redis {
    if (!this.client) {
      const url = ConfigManager.getInstance().config.REDIS_URL || "redis://localhost:6379";
      this.client = new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          if (times > 5) return null;
          return Math.min(times * 200, 2000);
        },
        lazyConnect: true,
      });

      this.client.on("error", (err) => {
        logger.error("Redis connection error", { error: err.message });
      });

      this.client.on("connect", () => {
        logger.info("Redis connected");
      });
    }

    if (this.client.status !== "ready" && this.client.status !== "connecting") {
      this.client.connect().catch(() => {});
    }

    return this.client;
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.getClient().get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      const client = this.getClient();
      if (ttlSeconds) {
        await client.set(key, value, "EX", ttlSeconds);
      } else {
        await client.set(key, value);
      }
    } catch {}
  }

  async incr(key: string): Promise<number> {
    try {
      return await this.getClient().incr(key);
    } catch {
      return 0;
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.getClient().del(key);
    } catch {}
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    try {
      await this.getClient().expire(key, ttlSeconds);
    } catch {}
  }

  // Returns an ownership token on success, null if the lock is already held.
  // The token exists so a holder whose lock expired mid-operation can't delete
  // the lock a *different* holder has since acquired — pass it back to
  // releaseLock. Truthy/falsy return keeps `if (!lock)` call sites working.
  async acquireLock(key: string, ttlMs = 30_000): Promise<string | null> {
    try {
      const client = this.getClient();
      const token = randomUUID();
      const result = await client.set(key, token, "PX", ttlMs, "NX");
      return result === "OK" ? token : null;
    } catch {
      return null;
    }
  }

  // Compare-and-delete: only removes the lock if `token` still owns it. Called
  // without a token it deletes unconditionally (legacy behavior).
  async releaseLock(key: string, token?: string): Promise<void> {
    if (!token) {
      await this.del(key);
      return;
    }
    try {
      // Single round-trip so the check and the delete can't interleave with
      // another client acquiring the lock between them.
      await this.getClient().eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        token
      );
    } catch { }
  }

  async getAndIncrementNonce(
    address: string,
    fetcher?: () => Promise<number>
  ): Promise<number> {
    const key = `nonce:${address}`;

    try {
      const client = this.getClient();
      const existing = await client.get(key);

      if (existing !== null) {
        const current = parseInt(existing, 10);
        await client.set(key, String(current + 1), "EX", 3600);
        return current;
      }

      let nonce = 0;
      if (fetcher) {
        try {
          nonce = await fetcher();
        } catch {
          nonce = 0;
        }
      }

      await client.set(key, String(nonce + 1), "EX", 3600);
      return nonce;
    } catch {
      return 0;
    }
  }

  async clearNonceCache(address: string): Promise<void> {
    await this.del(`nonce:${address}`);
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      logger.info("RedisService shut down");
    }
  }
}
