import type { Context, NextFunction } from "grammy";
import { RedisService } from "../../services/redis.js";

const MAX_COMMANDS = 10;
const WINDOW_SECONDS = 60;

export async function rateLimiter(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const redis = RedisService.getInstance();
  const key = `rate_limit:${userId}`;

  const count = await redis.incr(key);

  // Set the window on the first hit only. Without this the key never expires,
  // so a user who once reached MAX_COMMANDS stays rate-limited forever —
  // WINDOW_SECONDS being flagged as unused is what surfaced it.
  if (count === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }

  if (count > MAX_COMMANDS) {
    if (count === MAX_COMMANDS + 1) {
      await ctx.reply("⏳ Slow down — too many requests. Please wait a moment.");
    }
    return;
  }

  await next();
}
