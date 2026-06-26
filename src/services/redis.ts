import { logger } from "../utils/logger.js";

export class RedisService {
  private static instance: RedisService;
  private store: Map<string, { value: string; expiresAt: number }> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  static getInstance(): RedisService {
    if (!RedisService.instance) {
      RedisService.instance = new RedisService();
    }
    return RedisService.instance;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlSeconds ?? 300) * 1000,
    });
  }

  async incr(key: string): Promise<number> {
    const existing = await this.get(key);
    const value = (parseInt(existing ?? "0", 10) + 1).toString();
    const entry = this.store.get(key);
    await this.set(
      key,
      value,
      entry ? Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000)) : 60
    );
    return parseInt(value, 10);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async acquireLock(key: string, ttlSeconds = 30): Promise<boolean> {
    const existing = await this.get(key);
    if (existing) return false;
    await this.set(key, "locked", ttlSeconds);
    return true;
  }

  async releaseLock(key: string): Promise<void> {
    await this.del(key);
  }

  async getAndIncrementNonce(address: string, fetcher?: () => Promise<number>): Promise<number> {
    const key = `nonce:${address}`;
    const existing = await this.get(key);

    if (existing !== null) {
      const current = parseInt(existing, 10);
      await this.set(key, String(current + 1), 3600);
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

    await this.set(key, String(nonce + 1), 3600);
    return nonce;
  }

  async clearNonceCache(address: string): Promise<void> {
    await this.del(`nonce:${address}`);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.store.clear();
    logger.info("RedisService shut down");
  }
}
