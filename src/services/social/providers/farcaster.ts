import { ConfigManager } from "../../../config.js";
import { logger } from "../../../utils/logger.js";
import { CircuitBreakerRegistry } from "../../../utils/circuitBreaker.js";
import type { SocialPost, SocialProvider } from "../types.js";

const API_BASE = "https://api.neynar.com/v2/farcaster";

interface NeynarCast {
  hash: string;
  text: string;
  timestamp: string;
  author: { fid: number; username: string };
  parent_hash?: string | null;
  embeds?: { cast_id?: { hash: string } }[];
}

interface NeynarNotificationsResponse {
  notifications?: { cast?: NeynarCast; type?: string }[];
  next?: { cursor?: string };
}

/**
 * Farcaster mentions via Neynar.
 *
 * The author identifier is the **fid** — a permanent numeric account id — not
 * the username. Farcaster usernames can be changed and re-registered, so
 * authorizing on one would let whoever picks up an abandoned name spend
 * another user's funds. The fid is what SocialAccount stores.
 */
export class FarcasterProvider implements SocialProvider {
  readonly platform = "farcaster";

  private get config() {
    return ConfigManager.getInstance().config;
  }

  private get breaker() {
    return CircuitBreakerRegistry.getBreaker("social:farcaster");
  }

  isConfigured(): boolean {
    return Boolean(this.config.NEYNAR_API_KEY && this.config.FARCASTER_BOT_FID);
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/json",
      api_key: this.config.NEYNAR_API_KEY ?? "",
    };
  }

  async fetchMentions(sinceCursor?: string): Promise<{ posts: SocialPost[]; cursor?: string }> {
    if (!this.isConfigured()) return { posts: [] };

    const botFid = String(this.config.FARCASTER_BOT_FID);
    const params = new URLSearchParams({ fid: botFid, type: "mentions" });
    if (sinceCursor) params.set("cursor", sinceCursor);

    try {
      const response = await this.breaker.execute(() =>
        fetch(`${API_BASE}/notifications?${params}`, { headers: this.headers() })
      );

      if (!response.ok) {
        logger.warn("Farcaster mentions fetch failed", { status: response.status });
        return { posts: [], cursor: sinceCursor };
      }

      const body = (await response.json()) as NeynarNotificationsResponse;
      const posts: SocialPost[] = [];

      for (const notification of body.notifications ?? []) {
        const cast = notification.cast;
        if (!cast) continue;

        // A cast embedding another cast is quoting someone else's words —
        // the same injection surface a quote-tweet presents.
        if ((cast.embeds ?? []).some((e) => e.cast_id)) continue;
        if (String(cast.author.fid) === botFid) continue;

        posts.push({
          postId: cast.hash,
          authorId: String(cast.author.fid),
          authorHandle: cast.author.username,
          text: cast.text,
          createdAt: cast.timestamp ? new Date(cast.timestamp) : new Date(),
        });
      }

      return { posts, cursor: body.next?.cursor ?? sinceCursor };
    } catch (error) {
      logger.warn("Farcaster mentions fetch failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { posts: [], cursor: sinceCursor };
    }
  }

  async reply(postId: string, text: string): Promise<void> {
    if (!this.isConfigured()) return;

    const signerUuid = this.config.NEYNAR_SIGNER_UUID;
    if (!signerUuid) {
      // Reading mentions needs only an API key; posting needs a signer. Stating
      // that plainly beats a 4xx nobody traces back to missing config.
      logger.warn("Cannot reply on Farcaster: NEYNAR_SIGNER_UUID is not configured");
      return;
    }

    try {
      const response = await this.breaker.execute(() =>
        fetch(`${API_BASE}/cast`, {
          method: "POST",
          headers: { ...this.headers(), "content-type": "application/json" },
          body: JSON.stringify({
            signer_uuid: signerUuid,
            text: text.slice(0, 320),
            parent: postId,
          }),
        })
      );
      if (!response.ok) {
        logger.warn("Farcaster reply failed", { postId, status: response.status });
      }
    } catch (error) {
      // As with X: a failed reply never rolls back an executed trade.
      logger.warn("Farcaster reply failed", {
        postId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
