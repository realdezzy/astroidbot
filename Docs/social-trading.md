# Social trading

Tag the bot on X or Farcaster and it can place a trade for you.

**This is off by default and should stay off until you have read this page.** A public post moving real funds is the most dangerous input path in the product.

## Enabling it

```bash
SOCIAL_TRADING_ENABLED="true"
SOCIAL_BOT_HANDLES="astroidbot"
X_BEARER_TOKEN="..."        # X API v2
NEYNAR_API_KEY="..."        # Farcaster
```

`SOCIAL_TRADING_ENABLED` accepts `true`/`false`/`1`/`0` and is parsed as an enum, not coerced. (`Boolean("false")` is `true` in JavaScript, so a coerced kill switch would be *enabled* by the value meant to disable it.)

Setting it to `false` at runtime refuses every inbound command immediately, before any parsing or lookup.

## Linking an account

1. In Settings, choose Link X or Link Farcaster.
2. You get a one-time code.
3. Post or DM the code from the account you want to link.

Only the platform's **immutable user id** is stored for authorization. Handles are recorded for display and never trusted — handles are transferable and re-registrable, so authorizing on one would let whoever acquires an abandoned `@name` spend your funds.

An account cannot trade until `verifiedAt` is set.

## Supported phrasings

```
@astroidbot buy 50 usdc of $DEGEN on base
@astroidbot buy $25 of $WETH
@astroidbot buy 100 $BONK on solana
@astroidbot sell 10 $ETH
```

Parsing is a deterministic grammar. Anything it doesn't recognise is refused with an example rather than guessed at — that ordering is a security property, not a performance one. A model asked to interpret attacker-controlled text can be talked into interpreting instructions; a regex cannot.

If a symbol exists on more than one chain, the bot **asks which** rather than picking. The same ticker on two chains is two different assets.

## Confirmation modes

| Mode | Behaviour | Default |
|---|---|---|
| **Confirm-first** | Replies with a single-use link, valid 5 minutes, opening a prefilled trade form | ✅ |
| **Auto-execute** | Places the trade directly, still bounded by both caps | Opt-in per account |

## Limits

Two caps, both enforced **before** execution and **independently of `RiskManager`**:

| Setting | Default | Scope |
|---|---|---|
| `perTradeLimitUsd` | $50 | One command |
| `dailyLimitUsd` | $200 | Rolling 24 hours |
| commands/hour | 10 | Rate limit |

`RiskManager` governs trading risk. These govern how much damage a compromised social account can do — a different question with a different answer, which is why passing one does not exempt you from the other.

A token whose price cannot be determined is treated as **exceeding every limit**, not as free.

## What a post can and cannot do

A parsed command is a `SocialIntent`, which has exactly five fields: action, token, amount, denomination, and an optional chain hint.

There is **no field** for a wallet, a recipient, a spending limit, or an approval. A prompt-injected post cannot request those because the schema has nowhere to put them — containment by construction rather than by filtering. Validation additionally rejects any property outside that schema, since a model asked to emit JSON can be coaxed into adding one.

Before parsing, the bot strips URLs, retweet prefixes and quoted lines. Those carry *other people's* text inside your post and are the usual injection vector.

## Replay safety

Every command is recorded against `[platform, postId]` with a unique constraint. Streams redeliver, webhooks retry, and a restart can replay a backlog; without this the same post could trade more than once. A repeat delivery is a no-op.

## Audit trail

Every authorized command writes an `AuditLog` entry containing the raw post, the parsed intent, the authorization decision and the outcome. Rejections are recorded on `SocialCommand` with a reason.

## Turning it off

- **One account**: set `enabled = false` on the `SocialAccount`.
- **Auto-execute only**: set `autoExecute = false` — the account falls back to confirm-first.
- **Everything**: `SOCIAL_TRADING_ENABLED="false"`.

## Recommendation

Ship confirm-first only to begin with. Enable auto-execute per account, deliberately, with a low `perTradeLimitUsd`, once you have watched the audit log for a while.
