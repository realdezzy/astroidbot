import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { ConfigManager } from "../../src/config.js";

const redisStore = new Map<string, string>();
vi.mock("../../src/services/redis.js", () => ({
  RedisService: {
    getInstance: () => ({
      get: async (k: string) => redisStore.get(k) ?? null,
      set: async (k: string, v: string) => void redisStore.set(k, v),
    }),
  },
}));

const mockPrisma = {
  socialCommand: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
    findMany: vi.fn(),
  },
  socialAccount: { findUnique: vi.fn() },
  wallet: { findMany: vi.fn() },
  trade: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
};

vi.mock("../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => ({ prisma: mockPrisma }) },
}));

const mockDex = { getSwappableTokens: vi.fn(), getTokenPrice: vi.fn() };
vi.mock("../../src/services/dex/dexRegistry.js", () => ({
  DEXRegistry: { getInstance: () => mockDex },
}));

const tradableChains: { chainId: string }[] = [];
const descriptors: Record<string, { stableSymbol: string }> = {
  "base:mainnet": { stableSymbol: "USDC" },
};
vi.mock("../../src/services/chains/chainAdapterRegistry.js", () => ({
  ChainAdapterRegistry: {
    getInstance: () => ({
      tradable: () => tradableChains,
      get: (id: string) => ({ descriptor: descriptors[id] }),
    }),
  },
}));

const enqueueTrade = vi.fn();
vi.mock("../../src/services/queue.js", () => ({
  QueueManager: { getInstance: () => ({ enqueueTrade }) },
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface FetchOptions {
  body?: string;
  method?: string;
  headers?: Record<string, string>;
}

interface SocialAccountLookupArgs {
  where: {
    platform_platformUserId: {
      platform: string;
      platformUserId: string;
    };
  };
}

describe("Social Trading E2E Integration Pipeline", () => {
  const twitterPost = {
    id: "tweet-1001",
    text: "@astroidbot buy 25 usdc of $DEGEN on base",
    author_id: "x-user-999",
    created_at: "2026-07-29T20:00:00.000Z",
  };

  const farcasterCast = {
    hash: "0xcast123456",
    text: "@astroidbot buy 10 usdc of $DEGEN on base",
    author: { fid: 8888, username: "farcaster_trader" },
    timestamp: "2026-07-29T20:05:00.000Z",
  };

  const xLinkedAccount = {
    id: 10,
    userId: 100,
    platform: "x",
    platformUserId: "x-user-999",
    handle: "trader_x",
    verifiedAt: new Date(),
    perTradeLimitUsd: 100,
    dailyLimitUsd: 500,
    autoExecute: true,
    enabled: true,
  };

  const farcasterLinkedAccount = {
    id: 11,
    userId: 101,
    platform: "farcaster",
    platformUserId: "8888",
    handle: "farcaster_trader",
    verifiedAt: new Date(),
    perTradeLimitUsd: 100,
    dailyLimitUsd: 500,
    autoExecute: true,
    enabled: true,
  };

  function setupEnv() {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.SOCIAL_TRADING_ENABLED = "true";
    process.env.SOCIAL_BOT_HANDLES = "astroidbot";
    process.env.X_BEARER_TOKEN = "test-x-bearer-token";
    process.env.NEYNAR_API_KEY = "test-neynar-key";
    process.env.FARCASTER_BOT_FID = "7777";
    process.env.NEYNAR_SIGNER_UUID = "test-signer-uuid";
    delete process.env.TELEGRAM_BOT_TOKEN;
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.reset();
    ConfigManager.load();
  }

  beforeAll(() => {
    setupEnv();
  }, 30000);

  beforeEach(() => {
    vi.clearAllMocks();
    redisStore.clear();
    setupEnv();

    tradableChains.length = 0;
    tradableChains.push({ chainId: "base:mainnet" });

    mockPrisma.socialCommand.findUnique.mockResolvedValue(null);
    mockPrisma.socialCommand.create.mockResolvedValue({ id: 1 });
    mockPrisma.socialCommand.update.mockResolvedValue({});
    mockPrisma.socialCommand.count.mockResolvedValue(0);
    mockPrisma.socialCommand.findMany.mockResolvedValue([]);
    mockPrisma.wallet.findMany.mockResolvedValue([
      { id: 50, address: "0xuserwallet", chain: "base:mainnet", chainFamily: "evm" },
    ]);
    mockPrisma.auditLog.create.mockResolvedValue({});
    mockDex.getSwappableTokens.mockResolvedValue([
      { symbol: "DEGEN", contractId: "0xdegen", name: "Degen", decimals: 18 },
    ]);
    mockDex.getTokenPrice.mockResolvedValue(1);
  });

  it("executes an end-to-end X (Twitter) mention trade and posts a reply", async () => {
    mockPrisma.socialAccount.findUnique.mockImplementation(async (args: SocialAccountLookupArgs) => {
      if (args.where.platform_platformUserId.platform === "x") {
        return xLinkedAccount;
      }
      return null;
    });

    const postedReplies: Array<{ text: string; reply: { in_reply_to_tweet_id: string } }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: FetchOptions = {}) => {
        if (url.includes("/users/by/username/astroidbot")) {
          return jsonResponse({ data: { id: "bot-id-123", username: "astroidbot" } });
        }
        if (url.includes("/users/bot-id-123/mentions")) {
          return jsonResponse({
            data: [twitterPost],
            includes: { users: [{ id: "x-user-999", username: "trader_x" }] },
            meta: { result_count: 1, newest_id: "tweet-1001" },
          });
        }
        if (url.includes("/tweets")) {
          const body = JSON.parse(opts.body ?? "{}");
          postedReplies.push(body);
          return jsonResponse({ data: { id: "reply-tweet-1" } });
        }
        return jsonResponse({});
      })
    );

    const { SocialRegistry, pollSocialMentions } = await import("../../src/services/social/socialRegistry.js");
    const registry = SocialRegistry.getInstance();
    registry.reset();

    const { TwitterProvider } = await import("../../src/services/social/providers/twitter.js");
    registry.register(new TwitterProvider());

    await pollSocialMentions();

    expect(mockPrisma.socialAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { platform_platformUserId: { platform: "x", platformUserId: "x-user-999" } },
      })
    );

    expect(enqueueTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 50,
        userId: 100,
        tokenIn: "USDC",
        tokenOut: "DEGEN",
      })
    );

    expect(postedReplies.length).toBe(1);
    expect(postedReplies[0].reply.in_reply_to_tweet_id).toBe("tweet-1001");
    expect(postedReplies[0].text).toContain("Queued: buy");

    const cursor = redisStore.get("social:cursor:x");
    expect(cursor).toBe("tweet-1001");
  });

  it("executes an end-to-end Farcaster (Neynar) notification cast trade", async () => {
    mockPrisma.socialAccount.findUnique.mockImplementation(async (args: SocialAccountLookupArgs) => {
      if (args.where.platform_platformUserId.platform === "farcaster") {
        return farcasterLinkedAccount;
      }
      return null;
    });

    const postedCasts: Array<{ text: string; parent: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: FetchOptions = {}) => {
        if (url.includes("/farcaster/notifications")) {
          return jsonResponse({
            notifications: [
              {
                type: "mention",
                cast: farcasterCast,
              },
            ],
            next: { cursor: "2026-07-29T20:05:00.000Z" },
          });
        }
        if (url.includes("/farcaster/cast")) {
          const body = JSON.parse(opts.body ?? "{}");
          postedCasts.push(body);
          return jsonResponse({ cast: { hash: "0xreplycast123" } });
        }
        return jsonResponse({});
      })
    );

    const { SocialRegistry, pollSocialMentions } = await import("../../src/services/social/socialRegistry.js");
    const registry = SocialRegistry.getInstance();
    registry.reset();

    const { FarcasterProvider } = await import("../../src/services/social/providers/farcaster.js");
    registry.register(new FarcasterProvider());

    await pollSocialMentions();

    expect(mockPrisma.socialAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { platform_platformUserId: { platform: "farcaster", platformUserId: "8888" } },
      })
    );

    expect(enqueueTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 50,
        userId: 101,
        tokenIn: "USDC",
        tokenOut: "DEGEN",
      })
    );

    expect(postedCasts.length).toBe(1);
    expect(postedCasts[0].parent).toBe("0xcast123456");
    expect(postedCasts[0].text).toContain("Queued: buy");

    const cursor = redisStore.get("social:cursor:farcaster");
    expect(cursor).toBe("2026-07-29T20:05:00.000Z");
  });

  it("handles confirm-first flow when autoExecute is false", async () => {
    mockPrisma.socialAccount.findUnique.mockResolvedValue({
      ...xLinkedAccount,
      autoExecute: false,
    });

    const postedReplies: Array<{ text: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: FetchOptions = {}) => {
        if (url.includes("/users/by/username/astroidbot")) {
          return jsonResponse({ data: { id: "bot-id-123", username: "astroidbot" } });
        }
        if (url.includes("/users/bot-id-123/mentions")) {
          return jsonResponse({
            data: [twitterPost],
            includes: { users: [{ id: "x-user-999", username: "trader_x" }] },
            meta: { result_count: 1 },
          });
        }
        if (url.includes("/tweets")) {
          const body = JSON.parse(opts.body ?? "{}");
          postedReplies.push(body);
          return jsonResponse({ data: { id: "reply-tweet-2" } });
        }
        return jsonResponse({});
      })
    );

    const { SocialRegistry, pollSocialMentions } = await import("../../src/services/social/socialRegistry.js");
    const registry = SocialRegistry.getInstance();
    registry.reset();

    const { TwitterProvider } = await import("../../src/services/social/providers/twitter.js");
    registry.register(new TwitterProvider());

    await pollSocialMentions();

    expect(enqueueTrade).not.toHaveBeenCalled();

    expect(mockPrisma.socialCommand.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AWAITING_CONFIRMATION",
        }),
      })
    );

    expect(postedReplies.length).toBe(1);
    expect(postedReplies[0].text).toContain("Confirm within");
    expect(postedReplies[0].text).toContain("/trade?");
  });

  it("refuses unlinked authors and replies with linking instructions", async () => {
    mockPrisma.socialAccount.findUnique.mockResolvedValue(null);

    const postedReplies: Array<{ text: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: FetchOptions = {}) => {
        if (url.includes("/users/by/username/astroidbot")) {
          return jsonResponse({ data: { id: "bot-id-123", username: "astroidbot" } });
        }
        if (url.includes("/users/bot-id-123/mentions")) {
          return jsonResponse({
            data: [twitterPost],
            includes: { users: [{ id: "x-user-999", username: "trader_x" }] },
            meta: { result_count: 1 },
          });
        }
        if (url.includes("/tweets")) {
          postedReplies.push(JSON.parse(opts.body ?? "{}"));
          return jsonResponse({ data: { id: "reply-tweet-3" } });
        }
        return jsonResponse({});
      })
    );

    const { SocialRegistry, pollSocialMentions } = await import("../../src/services/social/socialRegistry.js");
    const registry = SocialRegistry.getInstance();
    registry.reset();

    const { TwitterProvider } = await import("../../src/services/social/providers/twitter.js");
    registry.register(new TwitterProvider());

    await pollSocialMentions();

    expect(enqueueTrade).not.toHaveBeenCalled();
    expect(postedReplies.length).toBe(1);
    expect(postedReplies[0].text).toContain("isn't linked");
  });

  it("prevents double-execution on re-polling via idempotency tracking", async () => {
    mockPrisma.socialAccount.findUnique.mockResolvedValue(xLinkedAccount);

    // Command previously executed in DB
    mockPrisma.socialCommand.findUnique.mockResolvedValue({ id: 1, status: "EXECUTED" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/users/by/username/astroidbot")) {
          return jsonResponse({ data: { id: "bot-id-123", username: "astroidbot" } });
        }
        if (url.includes("/users/bot-id-123/mentions")) {
          return jsonResponse({
            data: [twitterPost],
            includes: { users: [{ id: "x-user-999", username: "trader_x" }] },
            meta: { result_count: 1 },
          });
        }
        return jsonResponse({});
      })
    );

    const { SocialRegistry, pollSocialMentions } = await import("../../src/services/social/socialRegistry.js");
    const registry = SocialRegistry.getInstance();
    registry.reset();

    const { TwitterProvider } = await import("../../src/services/social/providers/twitter.js");
    registry.register(new TwitterProvider());

    await pollSocialMentions();

    expect(enqueueTrade).not.toHaveBeenCalled();
    expect(mockPrisma.socialCommand.create).not.toHaveBeenCalled();
  });
});
