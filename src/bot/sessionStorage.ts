import type { StorageAdapter } from "grammy";
import { RedisService } from "../services/redis.js";
import { logger } from "../utils/logger.js";
import type { SessionData } from "../types/bot.js";

const SESSION_PREFIX = "telegram:session:";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Shared grammY session storage, safe across restarts and multiple replicas. */
export function telegramSessionStorage(
  redis: Pick<RedisService, "get" | "set" | "del"> = RedisService.getInstance()
): StorageAdapter<SessionData> {
  return {
    async read(key) {
      const raw = await redis.get(`${SESSION_PREFIX}${key}`);
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as SessionData;
      } catch (error) {
        logger.warn("Discarding invalid Telegram session", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
        await redis.del(`${SESSION_PREFIX}${key}`);
        return undefined;
      }
    },
    async write(key, value) {
      await redis.set(`${SESSION_PREFIX}${key}`, JSON.stringify(value), SESSION_TTL_SECONDS);
    },
    async delete(key) {
      await redis.del(`${SESSION_PREFIX}${key}`);
    },
  };
}
