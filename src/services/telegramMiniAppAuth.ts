import crypto from "node:crypto";
import { ConfigManager } from "../config.js";
import { RedisService } from "./redis.js";

const MAX_AUTH_AGE_SECONDS = 10 * 60;

export interface TelegramMiniAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface VerifiedMiniAppLaunch {
  user: TelegramMiniAppUser;
  authDate: number;
  queryId?: string;
  startParam?: string;
}

export class TelegramMiniAppAuthService {
  static async verify(
    initData: string,
    nowSeconds = Math.floor(Date.now() / 1000),
    replayStore: Pick<RedisService, "setIfAbsent"> = RedisService.getInstance()
  ): Promise<VerifiedMiniAppLaunch> {
    const token = ConfigManager.getInstance().config.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("Telegram Mini App is not configured");

    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash") ?? "";
    if (!/^[a-f\d]{64}$/i.test(receivedHash)) throw new Error("Invalid Telegram signature");

    params.delete("hash");
    const checkString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
    const expected = crypto.createHmac("sha256", secret).update(checkString).digest();
    const received = Buffer.from(receivedHash, "hex");
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      throw new Error("Invalid Telegram signature");
    }

    const authDate = Number(params.get("auth_date"));
    if (!Number.isSafeInteger(authDate) || authDate > nowSeconds + 30 || nowSeconds - authDate > MAX_AUTH_AGE_SECONDS) {
      throw new Error("Telegram launch has expired");
    }

    let user: TelegramMiniAppUser;
    try {
      user = JSON.parse(params.get("user") ?? "") as TelegramMiniAppUser;
    } catch {
      throw new Error("Telegram user data is invalid");
    }
    if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error("Telegram user data is invalid");

    // A valid initData string is still a bearer credential. Accept it once so
    // copied launch data cannot mint sessions repeatedly during its age window.
    const replayKey = `telegram:miniapp:launch:${receivedHash}`;
    const accepted = await replayStore.setIfAbsent(
      replayKey,
      String(user.id),
      MAX_AUTH_AGE_SECONDS
    );
    if (!accepted) throw new Error("Telegram launch has already been used");

    return {
      user,
      authDate,
      ...(params.get("query_id") ? { queryId: params.get("query_id")! } : {}),
      ...(params.get("start_param") ? { startParam: params.get("start_param")! } : {}),
    };
  }
}
