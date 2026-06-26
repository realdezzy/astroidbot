import type { Context, NextFunction } from "grammy";
import { ConfigManager } from "../../config.js";

export async function adminGuard(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const adminIds = ConfigManager.getInstance().telegramAdminIds;
  const userBigInt = BigInt(userId);

  if (!adminIds.includes(userBigInt)) {
    // Silently ignore — don't leak bot existence to non-admins
    return;
  }

  await next();
}
