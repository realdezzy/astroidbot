import { describe, expect, it, vi } from "vitest";
import { initialSession } from "../../src/bot/session.js";
import { telegramSessionStorage } from "../../src/bot/sessionStorage.js";

describe("Telegram Redis session storage", () => {
  it("round-trips session data with a bounded lifetime", async () => {
    const values = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
      del: vi.fn(async (key: string) => { values.delete(key); }),
    };
    const storage = telegramSessionStorage(redis);
    const session = { ...initialSession(), activeChainId: "base:mainnet" };

    await storage.write("42", session);

    expect(redis.set).toHaveBeenCalledWith(
      "telegram:session:42",
      JSON.stringify(session),
      30 * 24 * 60 * 60
    );
    expect(await storage.read("42")).toEqual(session);
    await storage.delete("42");
    expect(await storage.read("42")).toBeUndefined();
  });

  it("removes malformed session data instead of breaking every update", async () => {
    const redis = {
      get: vi.fn(async () => "not-json"),
      set: vi.fn(async () => undefined),
      del: vi.fn(async () => undefined),
    };
    const storage = telegramSessionStorage(redis);

    expect(await storage.read("broken")).toBeUndefined();
    expect(redis.del).toHaveBeenCalledWith("telegram:session:broken");
  });
});
