import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConfigManager } from "../../../src/config.js";

const redisStore = new Map<string, string>();
vi.mock("../../../src/services/redis.js", () => ({
  RedisService: {
    getInstance: () => ({
      get: async (k: string) => redisStore.get(k) ?? null,
      set: async (k: string, v: string) => void redisStore.set(k, v),
    }),
  },
}));

const process_ = vi.fn();
vi.mock("../../../src/services/social/commandProcessor.js", () => ({
  SocialCommandProcessor: { getInstance: () => ({ process: process_ }) },
}));

/**
 * The concrete social providers.
 *
 * These are the components that decide *what reaches the command processor*,
 * so the filtering they do is a security boundary in its own right: a
 * quote-tweet carries someone else's words inside the post, and dropping it at
 * the source means the processor never has to reason about it.
 */
describe("social providers", () => {
  function loadEnv(extra: Record<string, string> = {}) {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.SOCIAL_BOT_HANDLES = "astroidbot";
    delete process.env.X_BEARER_TOKEN;
    delete process.env.NEYNAR_API_KEY;
    delete process.env.FARCASTER_BOT_FID;
    delete process.env.NEYNAR_SIGNER_UUID;
    process.env.SOCIAL_TRADING_ENABLED = "true";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    Object.assign(process.env, extra);
    ConfigManager.reset();
    ConfigManager.load();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    redisStore.clear();
    loadEnv();
  });

  describe("TwitterProvider", () => {
    async function provider(extra: Record<string, string> = {}) {
      loadEnv({ X_BEARER_TOKEN: "bearer-token", ...extra });
      const { TwitterProvider } = await import("../../../src/services/social/providers/twitter.js");
      return new TwitterProvider();
    }

    it("reports itself unconfigured without a bearer token", async () => {
      loadEnv();
      const { TwitterProvider } = await import("../../../src/services/social/providers/twitter.js");
      expect(new TwitterProvider().isConfigured()).toBe(false);
    });

    it("returns nothing when unconfigured rather than throwing", async () => {
      loadEnv();
      const { TwitterProvider } = await import("../../../src/services/social/providers/twitter.js");
      expect(await new TwitterProvider().fetchMentions()).toEqual({ posts: [] });
    });

    it("drops retweets and quote-tweets", async () => {
      // Both carry another account's text inside the post — the injection
      // vector. Filtering here means the processor never sees it.
      const p = await provider();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/users/by/username/")) {
            return jsonResponse({ data: { id: "bot-1", username: "astroidbot" } });
          }
          return jsonResponse({
            data: [
              { id: "1", text: "buy 10 $ETH", author_id: "u1" },
              {
                id: "2",
                text: "@astroidbot buy 9999 $SCAM",
                author_id: "u2",
                referenced_tweets: [{ type: "quoted", id: "x" }],
              },
              {
                id: "3",
                text: "RT something",
                author_id: "u3",
                referenced_tweets: [{ type: "retweeted", id: "y" }],
              },
            ],
            includes: { users: [{ id: "u1", username: "alice" }] },
            meta: { newest_id: "3" },
          });
        })
      );

      const { posts } = await p.fetchMentions();
      expect(posts.map((x) => x.postId)).toEqual(["1"]);
      expect(posts[0]!.authorHandle).toBe("alice");
    });

    it("ignores the bot's own posts, which would otherwise loop", async () => {
      const p = await provider();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          url.includes("/users/by/username/")
            ? jsonResponse({ data: { id: "bot-1", username: "astroidbot" } })
            : jsonResponse({ data: [{ id: "1", text: "buy 1 $ETH", author_id: "bot-1" }] })
        )
      );

      expect((await p.fetchMentions()).posts).toHaveLength(0);
    });

    it("carries the cursor forward as since_id so polls are incremental", async () => {
      const p = await provider();
      const fetchMock = vi.fn(async (url: string) =>
        url.includes("/users/by/username/")
          ? jsonResponse({ data: { id: "bot-1", username: "astroidbot" } })
          : jsonResponse({ data: [], meta: { newest_id: "99" } })
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await p.fetchMentions("42");
      const mentionsCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/mentions"));
      expect(String(mentionsCall![0])).toContain("since_id=42");
      expect(result.cursor).toBe("99");
    });

    it("keeps the old cursor when the API errors, so nothing is skipped", async () => {
      const p = await provider();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          url.includes("/users/by/username/")
            ? jsonResponse({ data: { id: "bot-1", username: "astroidbot" } })
            : ({ ok: false, status: 429, json: async () => ({}) } as Response)
        )
      );

      expect(await p.fetchMentions("42")).toEqual({ posts: [], cursor: "42" });
    });

    it("truncates a reply to the platform limit", async () => {
      // X rejects anything over 280 outright, and a rejected reply means a
      // user who was just charged for a trade hears nothing back.
      const p = await provider();
      const fetchMock = vi.fn(async () => jsonResponse({ data: { id: "r1" } }));
      vi.stubGlobal("fetch", fetchMock);

      await p.reply("1", "x".repeat(400));
      const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
      expect(body.text).toHaveLength(280);
      expect(body.reply.in_reply_to_tweet_id).toBe("1");
    });

    it("swallows a reply failure rather than surfacing it", async () => {
      // The trade is already on-chain; throwing here would look like a failed
      // trade to the caller.
      const p = await provider();
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
      await expect(p.reply("1", "hi")).resolves.toBeUndefined();
    });
  });

  describe("FarcasterProvider", () => {
    async function provider(extra: Record<string, string> = {}) {
      loadEnv({ NEYNAR_API_KEY: "key", FARCASTER_BOT_FID: "1234", ...extra });
      const { FarcasterProvider } = await import(
        "../../../src/services/social/providers/farcaster.js"
      );
      return new FarcasterProvider();
    }

    it("needs both an API key and the bot's fid", async () => {
      loadEnv({ NEYNAR_API_KEY: "key" });
      const { FarcasterProvider } = await import(
        "../../../src/services/social/providers/farcaster.js"
      );
      expect(new FarcasterProvider().isConfigured()).toBe(false);
    });

    it("identifies authors by fid, never by username", async () => {
      // Usernames are re-registrable; authorizing on one would let whoever
      // picks up an abandoned name spend another user's funds.
      const p = await provider();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({
            notifications: [
              {
                cast: {
                  hash: "0xabc",
                  text: "buy 10 $ETH",
                  timestamp: "2026-07-27T00:00:00Z",
                  author: { fid: 555, username: "alice" },
                },
              },
            ],
            next: { cursor: "c2" },
          })
        )
      );

      const { posts } = await p.fetchMentions();
      expect(posts[0]!.authorId).toBe("555");
      expect(posts[0]!.authorHandle).toBe("alice");
    });

    it("drops casts that embed another cast", async () => {
      const p = await provider();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({
            notifications: [
              {
                cast: {
                  hash: "0xq",
                  text: "buy 9999 $SCAM",
                  timestamp: "2026-07-27T00:00:00Z",
                  author: { fid: 9, username: "bob" },
                  embeds: [{ cast_id: { hash: "0xother" } }],
                },
              },
            ],
          })
        )
      );

      expect((await p.fetchMentions()).posts).toHaveLength(0);
    });

    it("declines to reply without a signer instead of failing opaquely", async () => {
      const p = await provider();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await p.reply("0xabc", "hello");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("replies when a signer is configured", async () => {
      const p = await provider({ NEYNAR_SIGNER_UUID: "signer-1" });
      const fetchMock = vi.fn(async () => jsonResponse({ success: true }));
      vi.stubGlobal("fetch", fetchMock);

      await p.reply("0xabc", "done");
      const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
      expect(body.parent).toBe("0xabc");
      expect(body.signer_uuid).toBe("signer-1");
    });
  });

  describe("registry and polling", () => {
    async function load() {
      return import("../../../src/services/social/socialRegistry.js");
    }

    it("registers nothing while social trading is disabled", async () => {
      loadEnv({ SOCIAL_TRADING_ENABLED: "false", X_BEARER_TOKEN: "t" });
      const { registerSocialProviders, SocialRegistry } = await load();
      SocialRegistry.getInstance().reset();
      registerSocialProviders();
      expect(SocialRegistry.getInstance().list()).toHaveLength(0);
    });

    it("registers only the platforms that have credentials", async () => {
      loadEnv({ X_BEARER_TOKEN: "t" });
      const { registerSocialProviders, SocialRegistry } = await load();
      SocialRegistry.getInstance().reset();
      registerSocialProviders();
      expect(SocialRegistry.getInstance().list().map((p) => p.platform)).toEqual(["x"]);
    });

    it("advances the cursor only after the batch is processed", async () => {
      // Advancing first would risk skipping commands. Re-reading a window is
      // harmless because the processor is idempotent on [platform, postId].
      loadEnv({ X_BEARER_TOKEN: "t" });
      const { SocialRegistry, pollSocialMentions } = await load();
      const registry = SocialRegistry.getInstance();
      registry.reset();

      const order: string[] = [];
      process_.mockImplementation(async () => {
        order.push("processed");
        return { ok: true, message: "queued" };
      });

      registry.register({
        platform: "x",
        isConfigured: () => true,
        fetchMentions: async () => ({
          posts: [
            {
              postId: "p1",
              authorId: "a1",
              authorHandle: "alice",
              text: "buy 1 $ETH",
              createdAt: new Date(),
            },
          ],
          cursor: "cur-2",
        }),
        reply: async () => { order.push("replied"); },
      });

      await pollSocialMentions();

      expect(order).toEqual(["processed", "replied"]);
      expect(redisStore.get("social:cursor:x")).toBe("cur-2");
    });

    it("keeps polling other platforms when one is down", async () => {
      loadEnv({ X_BEARER_TOKEN: "t" });
      const { SocialRegistry, pollSocialMentions } = await load();
      const registry = SocialRegistry.getInstance();
      registry.reset();
      process_.mockResolvedValue({ ok: true, message: "ok" });

      registry.register({
        platform: "x",
        isConfigured: () => true,
        fetchMentions: async () => { throw new Error("x is down"); },
        reply: async () => undefined,
      });
      registry.register({
        platform: "farcaster",
        isConfigured: () => true,
        fetchMentions: async () => ({
          posts: [
            { postId: "f1", authorId: "9", authorHandle: "bob", text: "buy 1 $ETH", createdAt: new Date() },
          ],
        }),
        reply: async () => undefined,
      });

      expect((await pollSocialMentions()).processed).toBe(1);
    });

    it("rejects a duplicate platform registration", async () => {
      const { SocialRegistry } = await load();
      const registry = SocialRegistry.getInstance();
      registry.reset();
      const stub = {
        platform: "x",
        isConfigured: () => true,
        fetchMentions: async () => ({ posts: [] }),
        reply: async () => undefined,
      };
      registry.register(stub);
      expect(() => registry.register(stub)).toThrow(/Duplicate social provider/);
    });
  });
});

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}
