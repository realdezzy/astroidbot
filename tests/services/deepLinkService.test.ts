import { describe, expect, it, vi } from "vitest";
import { DeepLinkService } from "../../src/services/deepLinks/deepLinkService.js";

describe("Telegram deep links", () => {
  it("creates a short opaque user-bound parameter", async () => {
    const redis = { set: vi.fn(), getDel: vi.fn().mockResolvedValue(null) };
    const service = new DeepLinkService(redis);
    const parameter = await service.create({
      target: { kind: "screen", screen: "portfolio" }, expectedUserId: 7, source: "web",
    }, 60);
    expect(parameter).toMatch(/^dl_[A-Za-z0-9_-]{32}$/);
    expect(parameter.length).toBeLessThanOrEqual(64);
    expect(redis.set.mock.calls[0]![0]).toMatch(/^telegram:link:.+:7$/);
    expect(redis.set.mock.calls[0]![2]).toBe(60);
  });

  it("consumes once for the intended user and validates the target", async () => {
    const raw = JSON.stringify({
      target: { kind: "token", chainId: "base:mainnet", contractId: "0xabc" },
      expectedUserId: 7, source: "notification",
    });
    const redis = { set: vi.fn(), getDel: vi.fn().mockResolvedValueOnce(raw) };
    const target = await new DeepLinkService(redis).consume(`dl_${"a".repeat(32)}`, 7);
    expect(target).toEqual({ kind: "token", chainId: "base:mainnet", contractId: "0xabc" });
    expect(redis.getDel).toHaveBeenCalledWith(`telegram:link:${"a".repeat(32)}:7`);
  });

  it("does not consume another user's bound key", async () => {
    const redis = { set: vi.fn(), getDel: vi.fn().mockResolvedValue(null) };
    expect(await new DeepLinkService(redis).consume(`dl_${"b".repeat(32)}`, 8)).toBeNull();
    expect(redis.getDel).not.toHaveBeenCalledWith(expect.stringMatching(/:7$/));
  });
});
