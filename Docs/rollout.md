# Enabling a chain in production

P7.6 in the implementation plan is "staged rollout", and it is the one item on
that list that isn't code. The mechanism exists — `ENABLED_CHAINS` is one
comma-separated variable and a restart — which is exactly why it needs a
procedure: a chain can be turned on for every user by editing one line, and
nothing in the system will ask whether that was a good idea.

This is that procedure. It assumes the chain already has a descriptor; adding
one is [chains.md](chains.md).

**This applies to chains beyond the default set.** `ENABLED_CHAINS` now
defaults to `stacks:mainnet,base:mainnet,solana:mainnet` — one chain per
execution family — because the product is multichain and a deployment that
configures nothing should get one. Those three are already through the checks
below: each runs without credentials, each has a working router, and each has
been exercised end to end. The procedure here is for the *next* chain — Celo,
Ethereum, Robinhood, or anything arriving through `CUSTOM_EVM_CHAINS`.

If you are upgrading a deployment that predates this default and has been
running Stacks-only, read that change the same way as any other chain
enablement: three chains will register where one did before. Existing wallets
are untouched — they keep their chain and their balances — but users gain the
ability to create wallets on the other two, and the indexer will begin
ingesting them. Pin the old behaviour with `ENABLED_CHAINS="stacks:mainnet"`
if you want to schedule that rather than take it on the next deploy.

## What "enabled" actually means

`ENABLED_CHAINS` decides which chains register at startup. A chain not named
there does not exist as far as the product is concerned — no wallets, no
balances, no quotes. A chain named there but misconfigured is a **startup
failure**, deliberately: a chain that silently failed to register is
indistinguishable from one nobody enabled.

Two separate switches beyond that:

- `descriptor.tradable` — whether `DEXRegistry` will ever quote it. A chain can
  be listable (wallets, balances, discovery) without being tradable. Arc ships
  this way.
- `dex.factory` in the descriptor — whether the indexer ingests it. Absent is a
  normal state, not a misconfiguration.

## The stages

### 0. Before anything, prove the chain answers

The failure this catches is the one that actually happened: `solana:mainnet`
was configured, registered, listed tokens, and could not route a single pair,
because Jupiter had retired the endpoint the descriptor named. Nothing failed
loudly — "no route" is a legitimate answer.

```bash
ENABLED_CHAINS="<chain>" npm run test:integration -- tests/integration/chainReachability.test.ts
```

A green run means a live quote and a live swap payload were obtained. Do not
skip this because the descriptor "looks right"; the descriptor looking right is
the state the Solana outage was in for weeks.

### 1. Testnet only

Enable the chain's testnet where one exists, on a staging deployment.

```bash
ENABLED_CHAINS="stacks:mainnet,base:sepolia"
```

Check, in this order:

- The process starts. A misconfiguration throws here, by design.
- `GET /api/health/chains` shows the chain `healthy: true`.
- A wallet can be created, and the address is accepted by the chain — the
  `walletLifecycle` integration suite covers exactly this.
- A quote returns for the native/stable pair.

### 2. Internal wallets on mainnet

Enable the mainnet chain, but keep the audience to wallets you control.

Fund one with a small amount and run the full path by hand: create → fund →
quote → trade → confirm → check the portfolio reflects it. `FUNDED_TESTNET_CHAIN`
and `FUNDED_TESTNET_KEY` drive the funded leg of the lifecycle suite.

Watch for a full day before going further, because two of the failure modes
only appear over time:

- **The indexer's first 24h.** A newly-indexed chain backfills downward to
  cover a 24h window; until that completes, its volume columns are partial. The
  indexer logs `[indexer] backfill complete` when the walk finishes.
- **Sponsorship costs.** If the chain uses ERC-4337, every user trade is
  charged to the paymaster. Check the Pimlico spend before it is exposed
  broadly, and decide whether `sponsorGas` should default on for this chain.

### 3. Open it up

Add the chain to `ENABLED_CHAINS` on production and restart.

Both containers must be restarted. The bot registers chains at startup and the
indexer does the same independently; leaving one behind gives you a chain that
trades but is never indexed, whose discovery rows then look like a chain nobody
uses.

## Rolling back

Remove the chain from `ENABLED_CHAINS` and restart. That is the whole
procedure, and it is safe in the sense that matters — no trade can be initiated
on a chain that isn't registered.

**What it does not do** is make existing wallets on that chain disappear. Their
rows remain, their funds remain on-chain, and the moment the chain is re-enabled
they work again. A user holding a balance on a chain you have just disabled
cannot move it through this product until you re-enable it, so this is a
decision to take deliberately rather than as a quick mitigation. If the concern
is a bad router rather than a bad chain, prefer flipping `tradable` to false in
the descriptor: that stops quoting while leaving balances reachable.

## When something is wrong

`GET /api/health/chains` reports per-chain RPC state, and admins are notified
through the usual channels when a chain crosses to unhealthy — three
consecutive failures, not one, since a single failure is the normal response to
an endpoint hiccuping.

Note that this endpoint answers "can this process reach the chain", which is
not the same question as "does this chain still route". A retired DEX endpoint
leaves RPC health perfectly green. That question is the reachability suite's,
and it is worth running against production's chain list on a schedule rather
than only at rollout.
