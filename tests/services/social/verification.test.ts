import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConfigManager } from "../../../src/config.js";
import type { SocialPost } from "../../../src/services/social/types.js";

/**
 * Proving ownership of a social account.
 *
 * The property under test throughout: `platformUserId` comes from
 * `post.authorId` — a value the *platform* returned when we asked it for
 * mentions — and never from anything a client supplied. Everything else here
 * is about not handing that guarantee away by accident.
 */

const verification = {
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
};

const socialAccount = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
};

const transaction = vi.fn().mockResolvedValue([]);

vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({
      prisma: {
        socialVerification: verification,
        socialAccount,
        $transaction: transaction,
      },
    }),
  },
}));

const { SocialVerificationService } = await import(
  "../../../src/services/social/verification.js"
);

function post(overrides: Partial<SocialPost> = {}): SocialPost {
  return {
    postId: "post-1",
    authorId: "platform-attested-777",
    authorHandle: "alice",
    text: "ASTROID-ABCD2345 — verifying my account with @astroidbot",
    createdAt: new Date(),
    ...overrides,
  };
}

function openChallenge(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    userId: 42,
    platform: "x",
    code: "ASTROID-ABCD2345",
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    ...overrides,
  };
}

describe("SocialVerificationService", () => {
  let service: InstanceType<typeof SocialVerificationService>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.reset();
    ConfigManager.load();
    service = SocialVerificationService.getInstance();
    transaction.mockResolvedValue([]);
  });

  describe("start", () => {
    it("issues an unguessable, unambiguous code", async () => {
      const { code } = await service.start(42, "x");

      expect(code).toMatch(/^ASTROID-[A-Z2-9]{8}$/);
      // No O/0 or I/1: the user retypes this from one screen to another, and a
      // code that fails on a misread character is indistinguishable from one
      // that was never seen.
      expect(code.slice(8)).not.toMatch(/[O0I1]/);
    });

    it("replaces any earlier open challenge for the same platform", async () => {
      // Several live codes for one user is a bigger surface for no benefit —
      // they are looking at one screen showing one code.
      await service.start(42, "x");
      expect(verification.deleteMany).toHaveBeenCalledWith({
        where: { userId: 42, platform: "x", consumedAt: null },
      });
    });
  });

  describe("tryConsume", () => {
    it("ignores a post that carries no code", async () => {
      expect(await service.tryConsume("x", post({ text: "buy 50 usdc of $DEGEN" }))).toBeNull();
      expect(verification.findUnique).not.toHaveBeenCalled();
    });

    it("links using the author id the platform reported", async () => {
      // The whole point. Nothing a client sent is involved.
      verification.findUnique.mockResolvedValue(openChallenge());
      socialAccount.findUnique.mockResolvedValue(null);

      const reply = await service.tryConsume("x", post());

      expect(reply).toMatch(/verified/i);
      expect(socialAccount.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { platform_platformUserId: { platform: "x", platformUserId: "platform-attested-777" } },
          create: expect.objectContaining({ userId: 42, platformUserId: "platform-attested-777" }),
        })
      );
    });

    it("consumes the challenge in the same transaction as the link", async () => {
      // Separately, a crash between the two leaves a code that can be replayed
      // by anyone who saw the public post.
      verification.findUnique.mockResolvedValue(openChallenge());
      socialAccount.findUnique.mockResolvedValue(null);

      await service.tryConsume("x", post());

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(transaction.mock.calls[0]![0]).toHaveLength(2);
    });

    it("refuses a code that has already been used", async () => {
      // The post is public and permanent, so the code is readable by anyone
      // forever. Single use is what stops that mattering.
      verification.findUnique.mockResolvedValue(openChallenge({ consumedAt: new Date() }));

      expect(await service.tryConsume("x", post())).toBeNull();
      expect(transaction).not.toHaveBeenCalled();
    });

    it("refuses a code issued for a different platform", async () => {
      // Otherwise a code shown on the X tab could be redeemed by posting it on
      // Farcaster, linking an account the user never intended.
      verification.findUnique.mockResolvedValue(openChallenge({ platform: "farcaster" }));

      expect(await service.tryConsume("x", post())).toBeNull();
      expect(transaction).not.toHaveBeenCalled();
    });

    it("says so when a code has expired, rather than failing silently", async () => {
      verification.findUnique.mockResolvedValue(
        openChallenge({ expiresAt: new Date(Date.now() - 1000) })
      );

      expect(await service.tryConsume("x", post())).toMatch(/expired/i);
      expect(transaction).not.toHaveBeenCalled();
    });

    it("stays silent about codes that do not exist", async () => {
      // Replying would confirm to someone probing which codes are real.
      verification.findUnique.mockResolvedValue(null);

      expect(await service.tryConsume("x", post())).toBeNull();
    });

    it("refuses to move an identifier already linked to another user", async () => {
      // Reassigning would hand whoever obtained a code the other user's
      // configured limits along with the link.
      verification.findUnique.mockResolvedValue(openChallenge());
      socialAccount.findUnique.mockResolvedValue({ id: 9, userId: 999 });

      const reply = await service.tryConsume("x", post());

      expect(reply).toMatch(/already linked/i);
      expect(transaction).not.toHaveBeenCalled();
    });

    it("lets the same user re-verify their own link", async () => {
      // Handles are renameable, so re-proving is how a stored handle is
      // refreshed. It must not trip the "already linked" guard.
      verification.findUnique.mockResolvedValue(openChallenge());
      socialAccount.findUnique.mockResolvedValue({ id: 9, userId: 42 });

      expect(await service.tryConsume("x", post())).toMatch(/verified/i);
      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it("starts a newly-linked account inside the configured caps", async () => {
      // An account is linked by posting publicly; the first thing a successful
      // link should be able to do is very little.
      verification.findUnique.mockResolvedValue(openChallenge());
      socialAccount.findUnique.mockResolvedValue(null);

      await service.tryConsume("x", post());

      expect(socialAccount.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ perTradeLimitUsd: 50, dailyLimitUsd: 200 }),
        })
      );
    });

    it("does not enable trading as a side effect of verifying", async () => {
      // Verification proves identity. Permission to move funds is a separate,
      // deliberate act — autoExecute stays at its default.
      verification.findUnique.mockResolvedValue(openChallenge());
      socialAccount.findUnique.mockResolvedValue(null);

      const reply = await service.tryConsume("x", post());

      const created = socialAccount.upsert.mock.calls[0]![0].create;
      expect(created).not.toHaveProperty("autoExecute", true);
      expect(reply).toMatch(/off until you enable it/i);
    });
  });
});
