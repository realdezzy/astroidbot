/**
 * Social trading contracts.
 *
 * This surface lets a public post move real funds, which makes it the most
 * dangerous input path in the product. Three rules shape everything here and
 * are enforced structurally rather than by convention:
 *
 *  1. Authorization keys on the platform's immutable user id, never a handle.
 *     Handles are transferable and re-registrable.
 *  2. Post text is data, never instruction. The LLM may only produce a
 *     schema-validated intent; it cannot name a wallet, raise a limit, or
 *     choose a recipient. See SocialIntent — there is nowhere to express those.
 *  3. Every command is idempotent on [platform, postId].
 */

export interface SocialPost {
  /** Stable per-platform id — the idempotency key. */
  postId: string;
  /** Immutable author id (numeric for X, fid for Farcaster). Never the handle. */
  authorId: string;
  /** Display handle. For rendering replies only; never for authorization. */
  authorHandle: string;
  text: string;
  createdAt: Date;
}

export interface SocialProvider {
  /** "x" | "farcaster" */
  readonly platform: string;
  /** True when this deployment has credentials for the platform. */
  isConfigured(): boolean;
  /** Posts addressed to the bot since the given cursor. */
  fetchMentions(sinceCursor?: string): Promise<{ posts: SocialPost[]; cursor?: string }>;
  /** Replies to a post. Failure must not roll back an executed trade. */
  reply(postId: string, text: string): Promise<void>;
}

/**
 * The complete set of things a social post is allowed to ask for.
 *
 * Deliberately minimal: there is no wallet field, no recipient, no limit
 * override, no chain-agnostic "do what I mean". A prompt-injected post cannot
 * request something outside this shape because the shape has nowhere to put
 * it — containment by construction rather than by filtering.
 */
export interface SocialIntent {
  action: "buy" | "sell";
  /** Token symbol or contract address as written. Resolved later, not trusted. */
  token: string;
  /** Amount denominated in `denomination`. */
  amount: number;
  /** What `amount` counts: the quote asset (usd) or the token itself. */
  denomination: "usd" | "token";
  /** Optional chain hint. An ambiguous symbol is never auto-resolved. */
  chainHint?: string;
}

export type SocialRejection =
  | "not_linked"
  | "not_verified"
  | "disabled"
  | "unparseable"
  | "ambiguous_token"
  | "unknown_token"
  | "over_per_trade_limit"
  | "over_daily_limit"
  | "rate_limited"
  | "no_wallet"
  | "globally_disabled"
  | "execution_failed";

export interface SocialDecision {
  ok: boolean;
  reason?: SocialRejection;
  message: string;
}
