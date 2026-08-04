import { ConfigManager } from "../../config.js";
import { RedisService } from "../redis.js";
import { logger } from "../../utils/logger.js";
import { SocialCommandProcessor } from "./commandProcessor.js";
import { TwitterProvider } from "./providers/twitter.js";
import { FarcasterProvider } from "./providers/farcaster.js";
import type { SocialProvider } from "./types.js";

/**
 * Registry of social platforms this deployment listens on.
 *
 * Mirrors DEXRegistry and ChainAdapterRegistry deliberately — three registries
 * with the same shape is one pattern to learn instead of three.
 */
export class SocialRegistry {
  private static instance: SocialRegistry;
  private providers = new Map<string, SocialProvider>();

  static getInstance(): SocialRegistry {
    if (!SocialRegistry.instance) {
      SocialRegistry.instance = new SocialRegistry();
    }
    return SocialRegistry.instance;
  }

  register(provider: SocialProvider): void {
    if (this.providers.has(provider.platform)) {
      throw new Error(`Duplicate social provider "${provider.platform}"`);
    }
    this.providers.set(provider.platform, provider);
    logger.info(`[SocialRegistry] Registered ${provider.platform}`);
  }

  get(platform: string): SocialProvider | undefined {
    return this.providers.get(platform);
  }

  list(): SocialProvider[] {
    return [...this.providers.values()];
  }

  reset(): void {
    this.providers.clear();
  }
}

/**
 * Registers whichever platforms are configured.
 *
 * Gated on SOCIAL_TRADING_ENABLED as well as credentials: having an API key
 * lying around in the environment must not be enough to start acting on public
 * posts. Enabling this is a decision, not a side effect of configuration.
 */
export function registerSocialProviders(): void {
  const config = ConfigManager.getInstance().config;
  const registry = SocialRegistry.getInstance();

  if (!config.SOCIAL_TRADING_ENABLED) {
    logger.info("[SocialRegistry] Social trading disabled — no providers registered");
    return;
  }

  for (const provider of [new TwitterProvider(), new FarcasterProvider()]) {
    if (provider.isConfigured()) {
      registry.register(provider);
    } else {
      logger.info(`[SocialRegistry] ${provider.platform} not configured — skipping`);
    }
  }

  if (registry.list().length === 0) {
    logger.warn(
      "[SocialRegistry] SOCIAL_TRADING_ENABLED is true but no platform has credentials"
    );
  }
}

/** Redis key holding the last-seen cursor for a platform. */
function cursorKey(platform: string): string {
  return `social:cursor:${platform}`;
}

/**
 * Polls every registered platform once and processes what it finds.
 *
 * Driven by the existing runCycle() fan-out rather than its own timer — the
 * codebase has exactly one periodic mechanism on purpose.
 *
 * The cursor is advanced only after a batch is processed. Losing it means
 * re-reading a window, which is harmless: SocialCommandProcessor is idempotent
 * on [platform, postId], so a replayed post is a no-op rather than a second
 * trade. That ordering is deliberate — advancing first would risk *skipping*
 * commands, which is the failure that loses a user's intent silently.
 */
export async function pollSocialMentions(): Promise<{ processed: number }> {
  const registry = SocialRegistry.getInstance();
  const providers = registry.list();
  if (providers.length === 0) return { processed: 0 };

  const redis = RedisService.getInstance();
  const processor = SocialCommandProcessor.getInstance();
  let processed = 0;

  for (const provider of providers) {
    try {
      const cursor = (await redis.get(cursorKey(provider.platform))) ?? undefined;
      const { posts, cursor: nextCursor } = await provider.fetchMentions(cursor);

      for (const post of posts) {
        try {
          const decision = await processor.process(provider.platform, post);

          // "Already processed" produces no message — replying again to a
          // redelivered post would spam the author.
          if (decision.message) {
            await provider.reply(post.postId, decision.message);
          }
          processed++;
        } catch (error) {
          logger.error("Social command processing failed", {
            platform: provider.platform,
            postId: post.postId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (nextCursor && nextCursor !== cursor) {
        await redis.set(cursorKey(provider.platform), nextCursor);
      }
    } catch (error) {
      // One platform being down must not stop the others.
      logger.warn("Social mention poll failed", {
        platform: provider.platform,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { processed };
}
