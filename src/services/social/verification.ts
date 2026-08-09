import crypto from "node:crypto";
import { DatabaseService } from "../db.js";
import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";
import type { SocialPost } from "./types.js";

/**
 * Proving that a social account belongs to the user linking it.
 *
 * Linking used to accept `platformUserId` from the request body — so the claim
 * "this X account is mine" was attested by whoever made the claim. The direct
 * attack is self-defeating (a social command trades from the *linking* user's
 * own wallet, so impersonating someone costs the impersonator money), but two
 * things still follow from it, and the second is the serious one:
 *
 *  1. Anyone could permanently occupy another account's identifier. The unique
 *     key on [platform, platformUserId] means the real owner could then never
 *     link at all.
 *  2. `verifiedAt` meant nothing. Every downstream decision that reads it —
 *     and every operator reading the table — was trusting a field that was
 *     only ever a self-declaration.
 *
 * The fix is to make the *platform* the attester. The user posts a one-time
 * code mentioning the bot; the mention poller reads the author id off that
 * post. The id therefore comes from the platform's own API response and never
 * from the client.
 */

/**
 * How long a challenge stays open.
 *
 * Long enough to switch apps, write a post and have the poller pick it up on
 * its next tick; short enough that a code left in someone's drafts or scraped
 * from a screenshot has expired by the time it is useful.
 */
const CODE_TTL_MS = 30 * 60 * 1000;

/**
 * Unambiguous alphabet: no O/0, I/1, or similar. The user retypes this from
 * one screen into another, and a code that fails because an l was read as a 1
 * is indistinguishable from one that was never seen.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_PREFIX = "ASTROID-";

export interface PendingVerification {
  code: string;
  platform: string;
  expiresAt: Date;
}

function generateCode(): string {
  // crypto, not Math.random: this string is the only thing standing between an
  // attacker and a link to an account they don't own.
  const bytes = crypto.randomBytes(CODE_LENGTH);
  const body = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${CODE_PREFIX}${body}`;
}

export class SocialVerificationService {
  private static instance: SocialVerificationService;

  static getInstance(): SocialVerificationService {
    if (!SocialVerificationService.instance) {
      SocialVerificationService.instance = new SocialVerificationService();
    }
    return SocialVerificationService.instance;
  }

  /**
   * Opens a challenge, replacing any earlier one for the same platform.
   *
   * Replacing rather than accumulating: several live codes for one user is a
   * larger surface for no benefit, and the user is looking at exactly one
   * screen showing exactly one code.
   */
  async start(userId: number, platform: string): Promise<PendingVerification> {
    const db = DatabaseService.getInstance();

    await db.prisma.socialVerification.deleteMany({
      where: { userId, platform, consumedAt: null },
    });

    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);

    await db.prisma.socialVerification.create({
      data: { userId, platform, code, expiresAt },
    });

    logger.info("Social verification started", { userId, platform });
    return { code, platform, expiresAt };
  }

  /** The user's open challenge for a platform, if any. */
  async pending(userId: number, platform: string): Promise<PendingVerification | null> {
    const row = await DatabaseService.getInstance().prisma.socialVerification.findFirst({
      where: { userId, platform, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });

    return row ? { code: row.code, platform: row.platform, expiresAt: row.expiresAt } : null;
  }

  /**
   * Links an account if this post carries an open challenge code.
   *
   * Returns a reply to send, or null when the post isn't a verification at all
   * — which is the overwhelmingly common case, so the cheap text check comes
   * before any database work.
   *
   * **`platformUserId` is taken from `post.authorId` and from nowhere else.**
   * That value came from the platform's own API in response to our query for
   * mentions; it is the whole basis on which this is trustworthy.
   */
  async tryConsume(platform: string, post: SocialPost): Promise<string | null> {
    if (!post.text.toUpperCase().includes(CODE_PREFIX)) return null;

    const match = post.text.toUpperCase().match(
      new RegExp(`${CODE_PREFIX}[${ALPHABET}]{${CODE_LENGTH}}`)
    );
    if (!match) return null;

    const db = DatabaseService.getInstance();
    const code = match[0];

    const challenge = await db.prisma.socialVerification.findUnique({ where: { code } });

    // Silence, not an error message. A code that doesn't exist is far more
    // likely to be someone pasting a screenshot than a genuine mistake, and
    // replying would confirm to a prober which codes are real.
    if (!challenge || challenge.consumedAt || challenge.platform !== platform) return null;

    if (challenge.expiresAt < new Date()) {
      return "That verification code has expired. Start again from Settings to get a new one.";
    }

    // The identifier may already belong to someone. Refused rather than
    // reassigned: silently moving a link would hand an attacker who got a code
    // an existing user's configured limits.
    const existing = await db.prisma.socialAccount.findUnique({
      where: { platform_platformUserId: { platform, platformUserId: post.authorId } },
    });

    if (existing && existing.userId !== challenge.userId) {
      logger.warn("Social verification rejected: identifier already linked elsewhere", {
        platform,
        userId: challenge.userId,
      });
      return "This account is already linked to a different AstroidBot user.";
    }

    const caps = ConfigManager.getInstance().config;

    await db.prisma.$transaction([
      db.prisma.socialVerification.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      }),
      db.prisma.socialAccount.upsert({
        where: { platform_platformUserId: { platform, platformUserId: post.authorId } },
        create: {
          userId: challenge.userId,
          platform,
          platformUserId: post.authorId,
          handle: post.authorHandle,
          verifiedAt: new Date(),
          perTradeLimitUsd: caps.SOCIAL_PER_TRADE_LIMIT_USD,
          dailyLimitUsd: caps.SOCIAL_DAILY_LIMIT_USD,
        },
        update: {
          // The handle refreshes because handles are renameable; the
          // identifier it is stored against does not change, which is the
          // whole reason authorization keys on the identifier.
          handle: post.authorHandle,
          verifiedAt: new Date(),
        },
      }),
    ]);

    logger.info("Social account verified", { platform, userId: challenge.userId });

    return (
      `✅ Verified — @${post.authorHandle} is now linked to your AstroidBot account. ` +
      `Trading by mention is off until you enable it in Settings.`
    );
  }

  /** Drops expired challenges. Called from the same tick as the mention poll. */
  async pruneExpired(): Promise<number> {
    const { count } = await DatabaseService.getInstance().prisma.socialVerification.deleteMany({
      where: { expiresAt: { lt: new Date() }, consumedAt: null },
    });
    return count;
  }
}
