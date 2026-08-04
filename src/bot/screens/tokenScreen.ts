import { InlineKeyboard } from "grammy";
import { resolveTokenQuery, type ResolvedToken } from "../../services/tokenResolver.js";
import { ChainAdapterRegistry } from "../../services/chains/chainAdapterRegistry.js";
import { escapeMd } from "../utils.js";
import type { BotContext } from "../../types/bot.js";

/**
 * Token lookup for Telegram.
 *
 * The bot had no way to see anything about a token you didn't already hold —
 * no search, no price, no way to find out whether something was tradable
 * before committing to a trade wizard. Meanwhile the web had a full discovery
 * surface over the same data. This closes that.
 *
 * It is also the entry point for buying by pasting: `/token <symbol|address>`
 * resolves, shows what is known, and offers a Trade button that jumps straight
 * into the wizard with both sides pre-filled.
 */

/** Compact USD, because a phone screen has no room for `$1,234,567.00`. */
function usd(value: number | null): string {
  if (value === null) return "unknown";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  // Small prices are the common case for the long tail, and rounding them to
  // two places renders every one of them as $0.00.
  return `$${value.toPrecision(3)}`;
}

/**
 * What a match is worth trusting, stated plainly.
 *
 * An address anyone can paste is exactly where a token with a spoofed symbol
 * lands, so the provenance is shown as prominently as the price. A ticker on
 * its own is not evidence of anything.
 */
function provenance(token: ResolvedToken): string {
  switch (token.source) {
    case "provider":
      return "✅ Listed by a DEX we route through";
    case "catalogue":
      return token.isVerified
        ? "✅ In the token catalogue, verified"
        : "🟡 In the token catalogue, unverified";
    case "indexed":
      return "🟠 Seen trading on-chain, not curated — check the contract";
    case "address":
      return "🔴 Unknown contract. Nothing has listed or seen this — verify it yourself";
  }
}

function describe(token: ResolvedToken): string {
  const descriptor = ChainAdapterRegistry.getInstance().find(token.chainId);
  const chainName = descriptor?.displayName ?? token.chainId;

  return [
    `*${escapeMd(token.symbol)}* — ${escapeMd(token.name)}`,
    `⛓ Chain: *${escapeMd(chainName)}*`,
    `💵 Price: \`${usd(token.priceUsd)}\``,
    `💧 Liquidity: \`${usd(token.liquidityUsd)}\``,
    `📄 Contract: \`${escapeMd(token.contractId)}\``,
    ``,
    provenance(token),
  ].join("\n");
}

/**
 * `/token <query>` — resolve and show, or offer a choice.
 */
export async function tokenScreen(ctx: BotContext, query: string): Promise<void> {
  const trimmed = query.trim();

  if (!trimmed) {
    await ctx.reply(
      "🔍 Send a token symbol or contract address:\n`/token WELSH`\n`/token 0x4200…0006`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Scoped to the chain the session is on when there is one, so a wallet on
  // Base doesn't get offered the Celo token of the same name.
  const active = ctx.session.activeChainId;
  let matches = await resolveTokenQuery(trimmed, active);

  // Nothing on this chain is not nothing anywhere. Widening beats a dead end,
  // as long as the chain is then shown on every result.
  if (matches.length === 0 && active) {
    matches = await resolveTokenQuery(trimmed);
  }

  if (matches.length === 0) {
    await ctx.reply(
      `❌ Nothing found for *${escapeMd(trimmed)}*.\n\n` +
        `Try a contract address, or browse tokens on the web dashboard.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Candidates are kept in the session and referenced by index: Telegram caps
  // callback data at 64 bytes, and a Stacks contract id can exceed that on its
  // own.
  ctx.session.tokenMatches = matches.map((m) => ({
    chainId: m.chainId,
    contractId: m.contractId,
  }));

  // One answer: show it with a Trade button.
  if (matches.length === 1) {
    await showToken(ctx, matches[0]!, 0);
    return;
  }

  // Several. Never picked for the user: the same ticker exists on several
  // chains, and choosing silently is how someone buys the wrong asset on the
  // wrong network.
  const keyboard = new InlineKeyboard();
  for (const [index, token] of matches.slice(0, 8).entries()) {
    const descriptor = ChainAdapterRegistry.getInstance().find(token.chainId);
    keyboard
      .text(
        `${token.symbol} · ${descriptor?.displayName ?? token.chainId} · ${usd(token.liquidityUsd)}`,
        `token_show:${index}`
      )
      .row();
  }
  keyboard.text("🏠 Home", "home");

  await ctx.reply(
    `🔍 *${escapeMd(trimmed)}* matches ${matches.length} tokens. Which one?`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
}

async function showToken(ctx: BotContext, token: ResolvedToken, index: number): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("💱 Trade this", `token_trade:${index}`)
    .row()
    .text("🏠 Home", "home");

  await ctx.reply(describe(token), { parse_mode: "Markdown", reply_markup: keyboard });
}

/**
 * One specific token, chosen from a disambiguation list.
 *
 * Re-resolved rather than read from the session, so a list opened an hour ago
 * shows the current price instead of the one it was rendered with.
 */
export async function tokenDetailScreen(ctx: BotContext, index: number): Promise<void> {
  const ref = ctx.session.tokenMatches?.[index];
  if (!ref) {
    await ctx.reply("❌ That list has expired. Send /token again.");
    return;
  }

  const matches = await resolveTokenQuery(ref.contractId, ref.chainId);
  const token = matches[0];

  if (!token) {
    await ctx.reply("❌ That token is no longer resolvable on this chain.");
    return;
  }

  await showToken(ctx, token, index);
}

/** The session reference behind a token button, for the trade handoff. */
export function tokenRefAt(
  ctx: BotContext,
  index: number
): { chainId: string; contractId: string } | undefined {
  return ctx.session.tokenMatches?.[index];
}
