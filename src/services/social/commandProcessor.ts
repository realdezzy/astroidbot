import crypto from "node:crypto";
import { DatabaseService } from "../db.js";
import { ConfigManager } from "../../config.js";
import { DEXRegistry } from "../dex/dexRegistry.js";
import { ChainAdapterRegistry } from "../chains/chainAdapterRegistry.js";
import { QueueManager } from "../queue.js";
import { walletChainId } from "../chains/walletChain.js";
import { logger } from "../../utils/logger.js";
import { parseIntent, sanitizePostText, validateIntent } from "./intentParser.js";
import type { SocialDecision, SocialIntent, SocialPost } from "./types.js";

/** How long a confirm-first link stays valid. Short: it authorizes a trade. */
const CONFIRM_TTL_MS = 5 * 60 * 1000;

/** Ceiling on commands per account per hour, independent of USD limits. */
const MAX_COMMANDS_PER_HOUR = 10;

/**
 * Turns an inbound social post into a trade — or, far more often, into a
 * refusal with a reason.
 *
 * Execution reuses the existing path exactly: RiskManager, then the trade
 * queue, then executeSwapPayload. Social is an *input surface* and introduces
 * no new way to move funds. Everything novel here is the authorization in
 * front of it.
 */
export class SocialCommandProcessor {
  private static instance: SocialCommandProcessor;

  static getInstance(): SocialCommandProcessor {
    if (!SocialCommandProcessor.instance) {
      SocialCommandProcessor.instance = new SocialCommandProcessor();
    }
    return SocialCommandProcessor.instance;
  }

  private get config() {
    return ConfigManager.getInstance().config;
  }

  private botHandles(): string[] {
    return this.config.SOCIAL_BOT_HANDLES.split(",")
      .map((h) => h.trim().replace(/^@/, ""))
      .filter(Boolean);
  }

  /**
   * Processes one post. Safe to call repeatedly with the same post: the
   * [platform, postId] unique constraint makes a redelivery a no-op rather
   * than a second trade.
   */
  async process(platform: string, post: SocialPost): Promise<SocialDecision> {
    const db = DatabaseService.getInstance();

    if (!this.config.SOCIAL_TRADING_ENABLED) {
      return this.reject("globally_disabled", "Social trading is currently disabled.");
    }

    // Idempotency first, before any work. Streams redeliver and restarts
    // replay backlogs; without this the same post trades twice.
    const existing = await db.prisma.socialCommand.findUnique({
      where: { platform_postId: { platform, postId: post.postId } },
    });
    if (existing) {
      logger.debug("Ignoring already-processed social post", { platform, postId: post.postId });
      return { ok: false, message: "Already processed." };
    }

    const command = await db.prisma.socialCommand.create({
      data: {
        platform,
        postId: post.postId,
        authorId: post.authorId,
        rawText: post.text,
        status: "RECEIVED",
      },
    });

    const decision = await this.evaluate(platform, post, command.id);

    if (!decision.ok) {
      await db.prisma.socialCommand.update({
        where: { id: command.id },
        data: { status: "REJECTED", rejectionReason: decision.reason },
      });
    }

    return decision;
  }

  private async evaluate(
    platform: string,
    post: SocialPost,
    commandId: number
  ): Promise<SocialDecision> {
    const db = DatabaseService.getInstance();

    // Authorization keys on the immutable platform id. A handle can be given
    // up and re-registered by anyone, so trusting it would let whoever
    // acquires an abandoned @name spend someone else's funds.
    const account = await db.prisma.socialAccount.findUnique({
      where: { platform_platformUserId: { platform, platformUserId: post.authorId } },
      include: { user: true },
    });

    if (!account) {
      return this.reject(
        "not_linked",
        "That account isn't linked to AstroidBot. Link it from Settings to trade by mention."
      );
    }
    if (!account.verifiedAt) {
      return this.reject("not_verified", "Finish verifying this account before trading.");
    }
    if (!account.enabled) {
      return this.reject("disabled", "Social trading is turned off for this account.");
    }

    const hourAgo = new Date(Date.now() - 3_600_000);
    const recent = await db.prisma.socialCommand.count({
      where: { socialAccountId: account.id, createdAt: { gte: hourAgo } },
    });
    if (recent >= MAX_COMMANDS_PER_HOUR) {
      return this.reject("rate_limited", "Too many commands this hour. Try again later.");
    }

    // Sanitize before parsing: quoted content and links are other people's
    // text riding inside this post, and that is the injection vector.
    const clean = sanitizePostText(post.text, this.botHandles());
    const intent = parseIntent(clean);

    if (!intent || !validateIntent(intent)) {
      return this.reject(
        "unparseable",
        'Couldn\'t read that. Try: "buy 50 usdc of $TOKEN on base".'
      );
    }

    const resolution = await this.resolveToken(intent);
    if ("error" in resolution) {
      return this.reject(resolution.reason, resolution.error);
    }

    const wallets = await db.prisma.wallet.findMany({ where: { userId: account.userId } });
    const wallet = wallets.find((w) => walletChainId(w) === resolution.chainId);
    if (!wallet) {
      return this.reject(
        "no_wallet",
        `You have no wallet on ${resolution.chainId}. Create one to trade this token.`
      );
    }

    const usdValue = await this.estimateUsd(intent, resolution.chainId);

    // Caps are checked here, before execution, and independently of
    // RiskManager. RiskManager governs trading risk; these govern how much
    // damage a compromised social account can do, which is a different
    // question with a different answer.
    if (usdValue > account.perTradeLimitUsd) {
      return this.reject(
        "over_per_trade_limit",
        `That's ~$${usdValue.toFixed(2)}, over your $${account.perTradeLimitUsd} per-trade limit.`
      );
    }

    const spentToday = await this.spentLast24h(account.id);
    if (spentToday + usdValue > account.dailyLimitUsd) {
      return this.reject(
        "over_daily_limit",
        `That would exceed your $${account.dailyLimitUsd} daily social limit.`
      );
    }

    await db.prisma.socialCommand.update({
      where: { id: commandId },
      data: { socialAccountId: account.id, parsedIntent: JSON.stringify(intent) },
    });

    await db.prisma.auditLog.create({
      data: {
        userId: account.userId,
        action: "SOCIAL_COMMAND_AUTHORIZED",
        details: JSON.stringify({
          platform,
          postId: post.postId,
          authorId: post.authorId,
          rawText: post.text,
          intent,
          usdValue,
        }),
      },
    });

    // Confirm-first is the default. Auto-execute is opt-in per account and
    // still bounded by both caps above.
    if (!account.autoExecute) {
      return this.issueConfirmation(commandId, intent, resolution.chainId, usdValue);
    }

    return this.execute(commandId, account.userId, wallet, intent, resolution, usdValue);
  }

  private async resolveToken(
    intent: SocialIntent
  ): Promise<
    | { chainId: string; symbol: string }
    | { error: string; reason: "ambiguous_token" | "unknown_token" }
  > {
    const registry = ChainAdapterRegistry.getInstance();
    const dex = DEXRegistry.getInstance();
    const chains = registry.tradable();

    const candidates: { chainId: string; symbol: string }[] = [];
    for (const chain of chains) {
      if (intent.chainHint && !chain.chainId.startsWith(intent.chainHint.toLowerCase())) continue;
      const tokens = await dex.getSwappableTokens(false, chain.chainId).catch(() => []);
      const hit = tokens.find((t) => t.symbol.toUpperCase() === intent.token.toUpperCase());
      if (hit) candidates.push({ chainId: chain.chainId, symbol: hit.symbol });
    }

    if (candidates.length === 0) {
      return {
        error: `Couldn't find ${intent.token} on any supported chain.`,
        reason: "unknown_token",
      };
    }

    // Never auto-pick. The same ticker on two chains is two different assets,
    // and guessing means spending on the wrong one.
    if (candidates.length > 1) {
      return {
        error:
          `${intent.token} exists on ${candidates.map((c) => c.chainId).join(", ")}. ` +
          `Say which, e.g. "on ${candidates[0]!.chainId.split(":")[0]}".`,
        reason: "ambiguous_token",
      };
    }

    return candidates[0]!;
  }

  private async estimateUsd(intent: SocialIntent, chainId: string): Promise<number> {
    if (intent.denomination === "usd") return intent.amount;

    const price = await DEXRegistry.getInstance()
      .getTokenPrice(intent.token, chainId)
      .catch(() => 0);

    // An unpriceable token is treated as exceeding any limit rather than as
    // free. Returning 0 here would let an unpriced token bypass both caps.
    return price > 0 ? intent.amount * price : Number.POSITIVE_INFINITY;
  }

  private async spentLast24h(socialAccountId: number): Promise<number> {
    const db = DatabaseService.getInstance();
    const since = new Date(Date.now() - 86_400_000);

    const commands = await db.prisma.socialCommand.findMany({
      where: { socialAccountId, status: "EXECUTED", createdAt: { gte: since } },
      select: { tradeId: true },
    });

    const tradeIds = commands.map((c) => c.tradeId).filter((id): id is number => id != null);
    if (tradeIds.length === 0) return 0;

    const trades = await db.prisma.trade.findMany({
      where: { id: { in: tradeIds } },
      select: { amountInUsd: true },
    });

    return trades.reduce((sum, t) => sum + (t.amountInUsd ?? 0), 0);
  }

  private async issueConfirmation(
    commandId: number,
    intent: SocialIntent,
    chainId: string,
    usdValue: number
  ): Promise<SocialDecision> {
    const db = DatabaseService.getInstance();
    // Single-use, unguessable, short-lived. It authorizes a trade, so it is
    // treated like a bearer credential.
    const token = crypto.randomBytes(32).toString("hex");

    await db.prisma.socialCommand.update({
      where: { id: commandId },
      data: {
        status: "AWAITING_CONFIRMATION",
        confirmToken: token,
        confirmExpiresAt: new Date(Date.now() + CONFIRM_TTL_MS),
      },
    });

    const origin = this.config.CORS_ORIGIN || "http://localhost:5173";
    const params = new URLSearchParams({
      chainId,
      tokenOut: intent.token,
      amount: String(intent.amount),
      confirm: token,
    });

    return {
      ok: true,
      message:
        `Ready: ${intent.action} ~$${usdValue.toFixed(2)} of ${intent.token} on ${chainId}. ` +
        `Confirm within 5 minutes: ${origin}/trade?${params}`,
    };
  }

  private async execute(
    commandId: number,
    userId: number,
    wallet: { id: number; address: string },
    intent: SocialIntent,
    resolution: { chainId: string; symbol: string },
    usdValue: number
  ): Promise<SocialDecision> {
    const db = DatabaseService.getInstance();

    try {
      const descriptor = ChainAdapterRegistry.getInstance().get(resolution.chainId).descriptor;
      const stable = descriptor.stableSymbol;

      const tokenIn = intent.action === "buy" ? stable : resolution.symbol;
      const tokenOut = intent.action === "buy" ? resolution.symbol : stable;
      const amountIn = intent.denomination === "usd" ? intent.amount : intent.amount;

      // Straight onto the existing queue — the same path the web and Telegram
      // interfaces use, so RiskManager and the single dispatch point still
      // apply exactly as they do everywhere else.
      await QueueManager.getInstance().enqueueTrade({
        walletId: wallet.id,
        userId,
        senderAddress: wallet.address,
        tokenIn,
        tokenOut,
        amountIn,
        direction: intent.action === "buy" ? "BUY" : "SELL",
        reason: `Social command (${resolution.chainId})`,
      });

      await db.prisma.socialCommand.update({
        where: { id: commandId },
        data: { status: "EXECUTED" },
      });

      return {
        ok: true,
        message: `Queued: ${intent.action} ~$${usdValue.toFixed(2)} of ${resolution.symbol} on ${resolution.chainId}.`,
      };
    } catch (error) {
      logger.error("Social command execution failed", {
        commandId,
        error: error instanceof Error ? error.message : String(error),
      });
      await db.prisma.socialCommand.update({
        where: { id: commandId },
        data: { status: "FAILED", rejectionReason: "execution_failed" },
      });
      return this.reject("execution_failed", "Something went wrong placing that trade.");
    }
  }

  private reject(reason: SocialDecision["reason"], message: string): SocialDecision {
    return { ok: false, reason, message };
  }
}
