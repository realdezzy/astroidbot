import { ConfigManager } from "../../../config.js";
import { logger } from "../../../utils/logger.js";
import { CircuitBreakerRegistry } from "../../../utils/circuitBreaker.js";
import type { SocialPost, SocialProvider } from "../types.js";

const API_BASE = "https://api.twitter.com/2";

interface XUser {
  id: string;
  username: string;
}

interface XTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  referenced_tweets?: { type: string; id: string }[];
}

interface XMentionsResponse {
  data?: XTweet[];
  includes?: { users?: XUser[] };
  meta?: { newest_id?: string; result_count?: number };
}

/**
 * X (Twitter) mentions via API v2.
 *
 * Polls `/users/:id/mentions` rather than holding a filtered stream: the bot
 * already has one global tick to hang work off, and a stream would need its
 * own reconnection and backfill handling for a surface that is rate-limited to
 * a handful of commands per account per hour anyway.
 *
 * Retweets and quote-tweets are dropped here rather than in the parser. A
 * quote carries someone *else's* text inside the post, which is the injection
 * vector the sanitiser also guards — filtering at the source means the
 * command processor never sees it at all.
 */
export class TwitterProvider implements SocialProvider {
  readonly platform = "x";
  private botUserId?: string;

  private get config() {
    return ConfigManager.getInstance().config;
  }

  private get breaker() {
    return CircuitBreakerRegistry.getBreaker("social:x");
  }

  isConfigured(): boolean {
    return Boolean(this.config.X_BEARER_TOKEN);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.X_BEARER_TOKEN}`,
      "Content-Type": "application/json",
    };
  }

  /** Resolves and caches the bot's own numeric id — mentions are keyed on it. */
  private async resolveBotUserId(): Promise<string | null> {
    if (this.botUserId) return this.botUserId;

    const handle = this.config.SOCIAL_BOT_HANDLES.split(",")[0]?.trim().replace(/^@/, "");
    if (!handle) {
      logger.warn("SOCIAL_BOT_HANDLES is empty — cannot resolve the X account to poll");
      return null;
    }

    try {
      const response = await this.breaker.execute(() =>
        fetch(`${API_BASE}/users/by/username/${handle}`, { headers: this.headers() })
      );
      if (!response.ok) {
        logger.warn("Failed to resolve X bot user", { handle, status: response.status });
        return null;
      }
      const body = (await response.json()) as { data?: XUser };
      this.botUserId = body.data?.id;
      return this.botUserId ?? null;
    } catch (error) {
      logger.warn("Failed to resolve X bot user", {
        handle,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async fetchMentions(sinceCursor?: string): Promise<{ posts: SocialPost[]; cursor?: string }> {
    if (!this.isConfigured()) return { posts: [] };

    const botId = await this.resolveBotUserId();
    if (!botId) return { posts: [] };

    const params = new URLSearchParams({
      max_results: "25",
      "tweet.fields": "created_at,author_id,referenced_tweets",
      expansions: "author_id",
      "user.fields": "username",
    });
    // since_id makes the poll incremental; without it a restart would re-read
    // the whole window and rely entirely on the idempotency guard downstream.
    if (sinceCursor) params.set("since_id", sinceCursor);

    try {
      const response = await this.breaker.execute(() =>
        fetch(`${API_BASE}/users/${botId}/mentions?${params}`, { headers: this.headers() })
      );

      if (!response.ok) {
        logger.warn("X mentions fetch failed", { status: response.status });
        return { posts: [], cursor: sinceCursor };
      }

      const body = (await response.json()) as XMentionsResponse;
      const usersById = new Map(
        (body.includes?.users ?? []).map((u) => [u.id, u.username] as const)
      );

      const posts: SocialPost[] = [];
      for (const tweet of body.data ?? []) {
        // A retweet or quote is someone else's words inside this post.
        const isRepost = (tweet.referenced_tweets ?? []).some(
          (r) => r.type === "retweeted" || r.type === "quoted"
        );
        if (isRepost) continue;
        if (!tweet.author_id) continue;
        // Never act on our own posts — that is a trivial feedback loop.
        if (tweet.author_id === botId) continue;

        posts.push({
          postId: tweet.id,
          authorId: tweet.author_id,
          authorHandle: usersById.get(tweet.author_id) ?? tweet.author_id,
          text: tweet.text,
          createdAt: tweet.created_at ? new Date(tweet.created_at) : new Date(),
        });
      }

      return { posts, cursor: body.meta?.newest_id ?? sinceCursor };
    } catch (error) {
      logger.warn("X mentions fetch failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { posts: [], cursor: sinceCursor };
    }
  }

  async reply(postId: string, text: string): Promise<void> {
    if (!this.isConfigured()) return;

    try {
      const response = await this.breaker.execute(() =>
        fetch(`${API_BASE}/tweets`, {
          method: "POST",
          headers: this.headers(),
          // X rejects anything over 280 characters outright, and a rejected
          // reply means a user who was charged for a trade hears nothing.
          body: JSON.stringify({ text: text.slice(0, 280), reply: { in_reply_to_tweet_id: postId } }),
        })
      );
      if (!response.ok) {
        logger.warn("X reply failed", { postId, status: response.status });
      }
    } catch (error) {
      // A failed reply must never roll back an executed trade — the trade is
      // already on-chain, and the user can see it in the app either way.
      logger.warn("X reply failed", {
        postId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
