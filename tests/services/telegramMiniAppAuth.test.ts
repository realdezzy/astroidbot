import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "../../src/config.js";
import { TelegramMiniAppAuthService } from "../../src/services/telegramMiniAppAuth.js";

const BOT_TOKEN = "123456:real-test-token";
const NOW = 1_800_000_000;

function signedInitData(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    auth_date: String(NOW),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    start_param: "token_abc",
    user: JSON.stringify({ id: 42, first_name: "Ada", username: "ada" }),
    ...overrides,
  });
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(checkString).digest("hex"));
  return params.toString();
}

describe("Telegram Mini App authentication", () => {
  beforeEach(() => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
    ConfigManager.reset();
    ConfigManager.load();
  });

  it("verifies signed launch data and consumes it once", async () => {
    const replayStore = { setIfAbsent: vi.fn().mockResolvedValue(true) };
    const launch = await TelegramMiniAppAuthService.verify(signedInitData(), NOW, replayStore);
    expect(launch.user).toMatchObject({ id: 42, username: "ada" });
    expect(launch.startParam).toBe("token_abc");
    expect(replayStore.setIfAbsent).toHaveBeenCalledWith(
      expect.stringMatching(/^telegram:miniapp:launch:/), "42", 600
    );
  });

  it("rejects tampering, stale launches, and replay", async () => {
    const available = { setIfAbsent: vi.fn().mockResolvedValue(true) };
    const tampered = new URLSearchParams(signedInitData());
    tampered.set("user", JSON.stringify({ id: 99 }));
    await expect(TelegramMiniAppAuthService.verify(tampered.toString(), NOW, available))
      .rejects.toThrow("Invalid Telegram signature");
    await expect(TelegramMiniAppAuthService.verify(signedInitData({ auth_date: String(NOW - 601) }), NOW, available))
      .rejects.toThrow("expired");
    await expect(TelegramMiniAppAuthService.verify(signedInitData(), NOW, { setIfAbsent: vi.fn().mockResolvedValue(false) }))
      .rejects.toThrow("already been used");
  });
});
