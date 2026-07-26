# AstroidBot — Multichain Product Implementation Plan

**Status:** proposal · **Author:** engineering · **Date:** 2026-07-26
**Scope:** take the current Stacks + Base(EVM) codebase to a fully multichain product spanning Stacks, Solana, and an open-ended set of EVM chains (Base, Celo, ARC, Robinhood Chain, …), with token discovery, social-agent trading, and a fully-migrated Telegram bot.

---

## 0. Executive summary

The multi-chain work already merged into the working tree got the *shape* right — `ChainAdapter`, `ChainAdapterRegistry`, `DEXProvider`, `DEXRegistry`, and the single `executeSwapPayload()` dispatch point are the correct seams. But it modelled a chain as a **single string, `chainFamily`**, and that identifier is doing two incompatible jobs at once:

1. *"Which execution shape does this chain use?"* — Clarity contract call vs. EVM UserOperation vs. Solana instruction.
2. *"Which network is this wallet actually on?"* — Base vs. Celo vs. ARC.

Those are not the same axis. Base and Celo share job 1 and differ on job 2. Today `BaseAdapter.chainFamily === "evm"`, and `ChainAdapterRegistry.register()` silently `return`s on a duplicate key (`chainAdapterRegistry.ts:20`), so **the second EVM adapter you register is dropped without an error**. `DEXRegistry.getProvidersForChain("evm")` (`dexRegistry.ts:38`) matches every EVM DEX on every EVM chain, so a Base wallet would be quoted by a Celo router and handed an unroutable contract address.

So the single highest-leverage change is **splitting chain identity into `family` (execution shape) + `chainId` (network)** and re-keying the registries on `chainId`. Everything else in this plan — Solana, four more EVM chains, token discovery, the social agent, the Telegram migration — is downstream of that, and each becomes small once it lands. Adding Celo after Phase 1 should be a ~40-line config object, not a new adapter.

**Phasing.** Phase 1 is the foundation and blocks 3, 4, 5. Phase 2 (Telegram) only depends on Phase 1's registry and can run in parallel with 3/4. Phase 5 (discovery) and Phase 6 (social) depend on 1 but not on each other.

```
P0 stabilize ──► P1 chain identity ──┬──► P2 Telegram ──────┐
                                     ├──► P3 Solana ────────┤
                                     ├──► P4 EVM chains ────┼──► P7 harden/ship
                                     ├──► P5 discovery ─────┤
                                     └──► P6 social ────────┘
```

**Concerns stated up front, then built around** (detail in §10):
- ARC and Robinhood Chain are new networks; whether they have a *live DEX with real liquidity* is an external fact we don't control. The registry makes them a config entry either way, so the plan separates **listable** (discovery/price) from **tradable** (a routing provider exists) and ships them as listable if that's all the chain supports today.
- Social trading (§7) lets a public tweet move real funds. That is a genuinely dangerous surface — prompt injection, handle spoofing, replay. It is designed here with a hard spend cap, account linking, idempotency, and no LLM in the authorization path. Do not ship it without §7.4.

---

## 1. Current state — verified inventory

Measured against the working tree as of `02d2513` plus uncommitted changes.

| Area | Files / size | State |
|---|---|---|
| Chain adapters | `src/services/chains/` — 574 lines | Stacks + Base. Registry keyed by family. |
| DEX providers | `src/services/dex/` — 1,736 lines | ALEX, Bitflow, Velar (Stacks); UniswapV3 (Base). |
| Dispatch | `chains/executeSwap.ts` — 103 lines | Correct single seam; `executeSwapPayload` / `confirmSwap`. |
| REST API | `src/api/` — 3,367 lines | Wallet create/import chain-aware ✅ |
| Telegram bot | `src/bot/` — 2,592 lines | **Zero `chainFamily` references.** Stacks-only wallets, one 1,387-line `router.ts`, a single `callback_query:data` handler. No tests. |
| Web | `web/src/pages/` — 17 pages | `/tokens` exists but is an auth-gated *blocklist manager*, not discovery. `Trade.tsx` has no deep-link prefill. |
| Social | — | Does not exist. |
| Schema | `prisma/schema.prisma` — 17 models | `Wallet.chainFamily`/`chain` ✅. No `Token` model. `Candle.token` is a bare symbol. |

### 1.1 Open defects this plan absorbs

Carried over from the last review, all re-verified as still live:

| # | Defect | Location | Phase |
|---|---|---|---|
| D1 | Registry key collision — 2nd EVM adapter silently dropped | `chainAdapterRegistry.ts:20` | P1 |
| D2 | `getProvidersForChain("evm")` matches all EVM chains | `dexRegistry.ts:38` | P1 |
| D3 | `Wallet.chain` persisted but never read for dispatch | `executeSwap.ts:36` | P1 |
| D4 | Bot creates Stacks-only wallets, ignores `chainFamily` | `bot/router.ts:373,973` | P2 |
| D5 | Bot duplicate check unscoped vs. `[chainFamily, address]` unique key | `bot/router.ts:375` | P2 |
| D6 | Bot token pickers unscoped — cross-chain tokens leak into lists | `portfolioScreen.ts:30`, `router.ts:438,450`, `ordersScreen.ts:84` | P2 |
| D7 | Hardcoded `"STX"` as native/default (8 sites) | `tradeScreen.ts` ×5, `ordersScreen.ts:73`, `router.ts:793,1289` | P2 |
| D8 | `Candle.token` is a bare symbol — collides across chains | `schema.prisma` | P5 |
| D9 | Lint red: 127 errors on clean checkout + `tests/` tsconfig misconfig | repo-wide | P0/P7 |
| D10 | Docs never mention multichain; 6 files still say `sUSDT` | `Docs/` | P7 |
| D11 | Bot has no portfolio-performance surface (commit `02d2513`) | `portfolioScreen.ts` | P2 |
| D12 | Base is ERC20↔ERC20 only; no native ETH wrap/unwrap | `uniswapV3Base.ts` | P4 |

---

## 2. Target architecture

### 2.1 Chain identity: two axes, not one

```ts
// src/types/chain.ts  (new)

/** Execution shape. Determines which adapter method a payload routes to. */
export type ChainFamily = "stacks" | "evm" | "svm";

/**
 * Network identity, `<network>:<environment>` — "base:mainnet", "celo:mainnet",
 * "solana:mainnet", "stacks:mainnet". This is the registry key and what
 * Wallet.chain already stores. One family, many chainIds.
 */
export type ChainId = string;

/**
 * Everything chain-specific that is *data*, not behaviour. Adding a new EVM
 * chain should mean adding one of these and nothing else.
 */
export interface ChainDescriptor {
  chainId: ChainId;
  family: ChainFamily;
  displayName: string;          // "Base", "Celo"
  nativeSymbol: string;         // "ETH", "CELO", "SOL", "STX"
  nativeDecimals: number;
  stableSymbol: string;         // symbol the chain's DEXs can actually route
  explorerTxUrl: (txId: string) => string;
  isTestnet: boolean;
  /** False when the chain is discoverable/priceable but has no routing DEX yet. */
  tradable: boolean;
  /** Family-specific config, narrowed by the adapter that consumes it. */
  evm?: EvmChainConfig;
  svm?: SvmChainConfig;
}
```

`chainFamily` is retained on `Wallet` (no migration of existing rows, no breaking change) but **stops being the dispatch key**. `Wallet.chain` — already populated with `adapter.chainId()` and already defaulted to `"stacks:mainnet"` — becomes the key. D3 is fixed by *using the column that already exists*.

### 2.2 Registry: keyed by chainId, indexed by family

```ts
// src/services/chains/chainAdapterRegistry.ts  (rewritten)
export class ChainAdapterRegistry {
  private byChainId = new Map<ChainId, ChainAdapter>();
  private byFamily = new Map<ChainFamily, ChainAdapter[]>();

  register(adapter: ChainAdapter): void {
    const id = adapter.descriptor.chainId;
    // Throw, don't silently return. A duplicate registration is a bug, and
    // swallowing it is exactly how D1 stayed invisible.
    if (this.byChainId.has(id)) throw new Error(`Duplicate chain adapter: ${id}`);
    this.byChainId.set(id, adapter);
    this.byFamily.set(adapter.descriptor.family, [...(this.byFamily.get(adapter.descriptor.family) ?? []), adapter]);
  }

  get(chainId: ChainId): ChainAdapter { /* throws with the registered list in the message */ }
  forFamily(family: ChainFamily): ChainAdapter[] { … }
  list(): ChainDescriptor[] { … }        // powers /api/chains and every UI picker
  tradable(): ChainDescriptor[] { … }
}
```

`DEXRegistry` gets the mirrored change: providers declare `chainId`, and `getProvidersForChain(chainId)` filters on it (D2). A compatibility shim maps a bare `"stacks"`/`"evm"` argument to the default chainId for that family during the migration window, then is deleted at the end of P1.

### 2.3 Adapter inheritance — generic base + chain-specific subclass

This is requirement #3 and the core of requirement #7. Three levels:

```
ChainAdapter                     (interface — the dispatch contract)
  └─ BaseChainAdapter            (abstract: locking, KMS decrypt, DRY_RUN, logging,
     │                            confirmation timeout — every family shares these)
     ├─ EvmChainAdapter          (abstract: viem clients, ERC-4337 via Pimlico,
     │  │                         batched calls, receipt polling, ERC-20 transfer)
     │  ├─ BaseAdapter           ── config only
     │  ├─ CeloAdapter           ── config only
     │  ├─ ArcAdapter            ── config only
     │  └─ RobinhoodAdapter      ── config only
     ├─ SolanaAdapter            (SVM: versioned tx, priority fees, blockhash retry)
     └─ StacksAdapter            (Clarity call + post-conditions; unchanged behaviour)
```

`BaseChainAdapter` hoists what `BaseAdapter` and `TransactionService` currently duplicate — the Redis wallet lock with the ownership token, JIT `KMSService.decryptPrivateKey`, the `DRY_RUN` short-circuit, structured logging, and the "no receipt after N minutes → FAILED" ageing rule (`baseAdapter.ts:231-250`). Today that ageing logic exists once, in Base; every future chain needs it, and copy-pasting it four times is exactly the failure mode this phase exists to prevent.

```ts
export abstract class BaseChainAdapter implements ChainAdapter {
  constructor(readonly descriptor: ChainDescriptor) {}

  get chainFamily() { return this.descriptor.family; }       // back-compat accessors
  get nativeSymbol() { return this.descriptor.nativeSymbol; }
  chainId() { return this.descriptor.chainId; }

  /** Template method: every chain's execution runs inside the same lock,
   *  DRY_RUN guard, key-decrypt and error envelope. Subclasses implement only
   *  the broadcast step. */
  protected async withWalletLock<T>(
    walletId: number,
    ttlMs: number,
    fn: (privateKeyHex: string, wallet: Wallet) => Promise<T>
  ): Promise<T | { error: string }> { … }

  protected abstract lockTtlMs(): number;   // 30s Stacks (broadcast), 300s ERC-4337 (receipt)
}
```

`EvmChainAdapter` then holds *all* of today's `baseAdapter.ts` behaviour, parameterised by `EvmChainConfig`:

```ts
export interface EvmChainConfig {
  viemChain: Chain;                  // viem/chains entry, or defineChain() for ARC/Robinhood
  rpcUrl?: string;
  bundler?: { kind: "pimlico"; urlTemplate: string } | { kind: "none" };
  entryPoint?: { address: Address; version: "0.7" };
  safeVersion?: "1.4.1";
  wrappedNative: Address;            // WETH / WCELO — needed for D12
  routers: { swapRouter: Address; quoter: Address; feeTiers: number[] };
}

export class BaseAdapter extends EvmChainAdapter {
  constructor() { super(BASE_DESCRIPTOR); }   // that is the whole class
}
```

**Custody fallback.** `EvmChainAdapter` must not assume ERC-4337 — Pimlico does not support every chain, and ARC/Robinhood may have no bundler at all. So it supports two custody modes behind one interface: `bundler.kind === "pimlico"` → Safe smart account, gas sponsored (today's Base behaviour, unchanged); `bundler.kind === "none"` → plain EOA via `viem` `walletClient.sendTransaction`, sequential calls instead of a batch, user pays gas. `generateWalletKeypair()` returns the Safe counterfactual address in the first mode and the EOA address in the second. This is the difference between "we support chains Pimlico supports" and "we support EVM."

### 2.4 Provider inheritance — the same treatment for DEXs

```
DEXProvider                      (interface)
  └─ BaseDEXProvider             (abstract: token-list cache, price cache, TTLs,
     │                            block-list filtering, quote error envelope)
     ├─ UniswapV3Provider        (abstract: QuoterV2 + SwapRouter02, fee-tier scan)
     │  ├─ UniswapV3BaseProvider     ── config only
     │  ├─ UbeswapCeloProvider       ── config only (Uniswap V3 fork)
     │  └─ …
     ├─ JupiterProvider          (Solana aggregator)
     └─ (existing Stacks providers adopt BaseDEXProvider incrementally)
```

`UniswapV3Provider` generalises `uniswapV3Base.ts` — the fee-tier scan, `quoteExactInputSingle`, `exactInputSingle` payload building, and the `assertValidAddresses()` startup check are identical for every V3 fork; only addresses and the token list differ. The existing Stacks providers are **not** rewritten in this plan (they work, they're tested, and churning them buys nothing); they adopt `BaseDEXProvider` opportunistically when touched.

### 2.5 Payload union — one more arm

`TransactionPayload` (`src/types.ts`) already discriminates on `kind`. Solana adds a third arm rather than being forced into either existing shape — the same reasoning that put `executeEvmCall` alongside `executeContractCall`:

```ts
| { kind: "svm"; instructions: SerializedInstruction[]; addressLookupTables?: string[] }
```

with `assertSvmPayload()` alongside the existing `assertStacksPayload()`, and a third branch in `executeSwapPayload()`. That function stays the single dispatch point — the CLAUDE.md rule that every trade-execution call site routes through it is what makes adding a chain family a one-file change rather than a five-call-site change.

---

## 3. Phase 0 — Stabilize (0.5 day)

Nothing below is safe to build on an uncommitted 25-file working tree.

- [ ] **P0.1** Commit the multi-chain fixes currently unstaged (quoter address, wallet creation, lock ownership token, chain scoping, `toDecimalString`, limit-order `stableSymbol`) as one reviewed commit with the two migrations.
- [ ] **P0.2** Fix the `tests/` tsconfig misconfiguration (D9) so lint runs over tests at all.
- [ ] **P0.3** Baseline lint: fix the mechanical class (unused vars, trivial `any`), and `eslint-disable` with a tracking comment for the rest. Wire `lint` into CI as a **required** gate so the count can only go down.
- [ ] **P0.4** Tag `pre-multichain-v2` for a rollback point.

**Exit:** clean tree, green typecheck, green tests (225), green lint gate.

---

## 4. Phase 1 — Chain identity foundation (3–4 days) 🔑

The blocking phase. No new chain is addable until this lands.

- [ ] **P1.1** Add `src/types/chain.ts` — `ChainFamily`, `ChainId`, `ChainDescriptor`, `EvmChainConfig`, `SvmChainConfig`.
- [ ] **P1.2** Add `src/services/chains/descriptors/` — one file per chain, exporting a `ChainDescriptor`. `index.ts` exports `ALL_DESCRIPTORS`. **This directory is the answer to "how do I add a chain."**
- [ ] **P1.3** Rewrite `ChainAdapterRegistry`: key on `chainId`, index by family, throw on duplicates, add `list()` / `tradable()` / `forFamily()`.
- [ ] **P1.4** Extract `BaseChainAdapter` (lock/KMS/DRY_RUN/confirmation-ageing template) and `EvmChainAdapter` (all of today's `baseAdapter.ts`, parameterised); reduce `BaseAdapter` to a config subclass. Add the EOA custody mode.
- [ ] **P1.5** Add `chainId` to `DEXProvider`; re-key `DEXRegistry.getProvidersForChain` on it (D2); add the temporary family→default-chainId shim.
- [ ] **P1.6** Thread `chainId` through the dispatch path: `executeSwapPayload`/`confirmSwap` take `chainId` and resolve the adapter by it (D3). Update all five call sites (`userController.executeTrade`, `strategyEngine.executeApprovedActions`, `tradeWorker.processTradeJob`, `limitOrder.ts`, `cycleOrchestrator.ts`).
- [ ] **P1.7** Config: replace the single `BASE_NETWORK`/`PIMLICO_API_KEY` pair with `ENABLED_CHAINS` (comma-separated chainIds) plus per-chain RPC/key vars in `envSchema`. `bootstrap()` registers exactly the adapters in `ENABLED_CHAINS`, failing loudly on an unknown or misconfigured id. Default `ENABLED_CHAINS=stacks:mainnet` preserves current deployments byte-for-byte.
- [ ] **P1.8** New `GET /api/chains` → `registry.list()`. Every chain picker in web and Telegram reads this; **no chain list is ever hardcoded in a UI again.**
- [ ] **P1.9** Migration: backfill `Wallet.chain` where it disagrees with `chainFamily`; add `@@index([userId, chain])`.
- [ ] **P1.10** Tests: registry duplicate-rejection, family indexing, dispatch-by-chainId, two EVM adapters coexisting (**the regression test for D1**), EOA-vs-smart-account custody.

**Exit:** two EVM chains registered simultaneously, each quoting only its own DEXs; full suite green.

---

## 5. Phase 2 — Telegram bot: multichain + modular (4–5 days)

Runs parallel to P3/P4. Fixes D4–D7, D11 and requirement #6.

### 5.1 Structural refactor first
`router.ts` is 1,387 lines with a single `callback_query:data` handler — unmaintainable and untestable, and the reason the bot was skipped during the last migration.

```
src/bot/
  router.ts            → thin: wires commands to the dispatcher (~150 lines)
  callbacks/
    registry.ts        → CallbackRoute[] { pattern, handler }, typed payload parsing
    wallet.ts  trade.ts  portfolio.ts  orders.ts  agents.ts  settings.ts  chain.ts
  screens/             → existing, but pure render functions: (state) → { text, keyboard }
  keyboards/
    builders.ts        → chainPicker(), tokenPicker(), confirmCancel(), paginate()
  session/             → typed conversation state (replaces ad-hoc text-mode flags)
```

Callback data gets a **typed namespaced codec** (`trade:sel:<chainId>:<symbol>`) with an encode/decode pair and a 64-byte length guard — Telegram silently truncates past that, and hand-built strings are how chain context gets lost.

- [ ] **P2.1** Extract the callback dispatcher + typed codec; move handlers into `callbacks/`.
- [ ] **P2.2** Screens become pure `(state) => {text, keyboard}` — directly unit-testable, no `ctx`.
- [ ] **P2.3** Shared keyboard builders, including `chainPicker()` fed by `registry.list()`.

### 5.2 Multichain behaviour
- [ ] **P2.4** **Wallet create/import through the adapter** (D4/D5) — mirrors `userController`; chain picker first, then generate/import; duplicate check passes `chainFamily`. *This closes the last unreachable-chain path in the product.*
- [ ] **P2.5** Session carries an active `chainId`; every token list, quote and order is scoped to it (D6).
- [ ] **P2.6** Replace all 8 hardcoded `"STX"` sites with `descriptor.nativeSymbol`/`stableSymbol` (D7).
- [ ] **P2.7** Portfolio screen groups holdings by chain, shows per-chain and total USD, and surfaces the performance/candle data from `02d2513` (D11).
- [ ] **P2.8** Explorer links via `descriptor.explorerTxUrl` instead of the hardcoded Stacks explorer.

### 5.3 Button-first UX
- [ ] **P2.9** Every flow reachable by tap: chain → wallet → token in → token out → amount (preset chips `25% / 50% / 75% / Max` + custom) → quote preview → **Confirm/Cancel**. Free text remains a shortcut, never a requirement.
- [ ] **P2.10** Inline-edit screens (`editMessageText`) rather than appending messages, with a breadcrumb header (`🔵 Base · Wallet 1`) so chain context is always visible — the main way users lose track of which chain they're on.
- [ ] **P2.11** Quote preview shows route, price impact, fee, min-received, and a countdown before the quote goes stale.
- [ ] **P2.12** First bot tests: codec round-trip, screen renders, wallet-creation flow per family (currently the largest untested file in the repo).

**Exit:** a Telegram user can create a wallet on any enabled chain and complete a trade without typing anything but the amount.

---

## 6. Phases 3 & 4 — New chains

### Phase 3 — Solana (4–5 days)
First non-EVM addition; proves the family abstraction generalises beyond "EVM or not."

- [ ] **P3.1** `svm` family: `SvmChainConfig`, `solana:mainnet`/`solana:devnet` descriptors.
- [ ] **P3.2** `SolanaAdapter extends BaseChainAdapter` — `@solana/web3.js`, keypair gen/derive (base58), `executeSvmCall({ instructions })`, versioned transactions, priority fees, blockhash-expiry retry, `confirmTransaction` via signature status.
- [ ] **P3.3** Custody: ed25519 secret key encrypted through the existing `KMSService`/`crypto.ts` — chain-agnostic, no changes needed.
- [ ] **P3.4** `JupiterProvider extends BaseDEXProvider` — quote + swap-instructions API, Jupiter token list, SPL decimals.
- [ ] **P3.5** SPL + native SOL balances in `PortfolioManager` (extend the `0x`-prefix detection at `portfolio.ts:159` into an explicit `descriptor`-driven resolver — address-shape sniffing does not survive three families).
- [ ] **P3.6** ATA (associated token account) creation folded into the swap instruction set.
- [ ] **P3.7** Devnet integration test + mocked unit tests.

### Phase 4 — EVM fleet: Celo, ARC, Robinhood (2–3 days *if* P1 is right)
The test of the architecture: each chain should be a descriptor plus a provider config.

- [ ] **P4.1** Celo — descriptor + `UbeswapCeloProvider` (V3 fork) + cUSD as `stableSymbol`.
- [ ] **P4.2** ARC — descriptor via `defineChain()`; register as `tradable: false` (listable only) until a router with real liquidity is confirmed, then flip one boolean.
- [ ] **P4.3** Robinhood Chain — same treatment.
- [ ] **P4.4** **Native wrap/unwrap** (D12): `EvmChainAdapter.wrapNative()`/`unwrapNative()` prepended to the call batch when `tokenIn`/`tokenOut` is the native asset. One implementation serves every EVM chain — the reason to do it here rather than in Base alone.
- [ ] **P4.5** Per-chain gas-policy config (sponsored vs. user-paid) surfaced in quote previews so users see the true cost.
- [ ] **P4.6** A shared `describe.each` conformance suite every EVM adapter must pass — the guard rail that keeps chain #7 cheap.

**Success metric for the architecture:** if P4.1 takes more than a day, P1 was under-built — stop and fix P1 rather than paying that cost per chain.

---

## 7. Phase 5 — Token discovery & deep-link trading (4–5 days)

Requirement #4. Note `/tokens` already exists but is an **auth-gated blocklist manager**; it is repurposed, and discovery is built as a new public surface.

### 7.1 Data layer
```prisma
model Token {
  id           Int      @id @default(autoincrement())
  chainId      String                 // "base:mainnet"
  contractId   String                 // address / principal / mint
  symbol       String
  name         String
  decimals     Int
  logoUrl      String?
  priceUsd     Float?
  priceChange24h Float?
  volume24h    Float?
  liquidityUsd Float?
  marketCapUsd Float?
  isVerified   Boolean  @default(false)
  lastSyncedAt DateTime?
  @@unique([chainId, contractId])
  @@index([chainId, volume24h])
  @@index([symbol])
}
```
- [ ] **P5.1** `Token` model + migration.
- [ ] **P5.2** **Fix D8**: add `chainId` to `Candle` (`@@unique([chainId, token, timeframe, timestamp])`), backfill existing rows to `stacks:mainnet`. Without this, Base USDC candles overwrite Stacks USDC candles — silent data corruption that gets worse with every chain added.
- [ ] **P5.3** `TokenDiscoveryService` — periodic sync over `registry.tradable()` pulling each provider's token list + price/liquidity. Scheduled through the **existing `runCycle()` fan-out**, per CLAUDE.md's "no second scheduler" rule.

### 7.2 API
- [ ] **P5.4** Public, unauthenticated, rate-limited, cached:
  - `GET /api/tokens/discover?chainId=&sort=volume|change|liquidity&q=&page=` — cross-chain list, chain filter optional
  - `GET /api/tokens/:chainId/:contractId` — detail + 24h stats
  - `GET /api/tokens/:chainId/:contractId/candles?timeframe=` — chart data
- [ ] **P5.5** Keep the authed blocklist endpoints where they are; the public routes are read-only and never touch user state.

### 7.3 Web
- [ ] **P5.6** `Tokens.tsx` → **public** `TokenDiscovery.tsx` at `/tokens`, outside `ProtectedRoute`: searchable/sortable table, chain filter chips, sparklines, chain badges. The current blocklist UI moves to `/settings/tokens`.
- [ ] **P5.7** `TokenDetail.tsx` at `/tokens/:chainId/:contractId` — chart (reuse `TradingViewChart`), stats, links, and a prominent **Trade** button.
- [ ] **P5.8** Add the `Tokens` link to the Landing nav (`Landing.tsx:126-130` and the footer at `:572`).
- [ ] **P5.9** **Deep-link prefill** — `Trade.tsx` reads `useSearchParams()` for `chainId`/`tokenOut`/`tokenIn`, preselects the chain, auto-picks a compatible wallet (prompting to create one if none exists on that chain), and focuses the amount field. *Requirement #4's "they just enter amount and trade" is exactly this.*
- [ ] **P5.10** Unauthenticated Trade click → login/register with `?redirect=` preserving the full prefill, so the intent survives the auth round-trip.
- [ ] **P5.11** Reusable `<ChainBadge>`, `<TokenAvatar>`, `<ChainFilter>` in `web/src/components/`.

---

## 8. Phase 6 — Social agent: X / Farcaster (5–6 days)

Requirement #5: mention the bot, get a trade. Highest-risk surface in the plan.

### 8.1 Architecture — provider abstraction, mirroring the chain registry
```
SocialProvider                  (interface: poll/stream mentions, reply, resolve author)
  ├─ TwitterProvider            (X API v2 filtered stream / mentions polling)
  └─ FarcasterProvider          (Neynar webhooks, or hub polling)

SocialCommandProcessor          (shared, provider-agnostic: parse → authorize → execute → reply)
```
- [ ] **P6.1** `src/services/social/` with `SocialProvider` + `SocialRegistry` (same shape as `DEXRegistry`/`ChainAdapterRegistry` — one recognisable pattern for all three).
- [ ] **P6.2** `SocialAccount` model: `userId`, `platform`, `platformUserId`, `handle`, `verifiedAt`, `dailyLimitUsd`, `perTradeLimitUsd`, `enabled`.
- [ ] **P6.3** Verification flow — user links from web/Telegram, gets a one-time code, posts or DMs it; only `platformUserId` (immutable) is trusted thereafter, **never the handle** (handles are transferable).

### 8.2 Command path
- [ ] **P6.4** `SocialCommandProcessor`: deterministic regex/grammar parse first (`buy 50 usdc of $DEGEN on base`); the LLM is a **fallback for phrasing only**, and its output is re-validated against the same schema. Reuses `AIOrchestrator.parseCommand` (`ai.ts:233`).
- [ ] **P6.5** Resolve symbol → token via `TokenDiscoveryService`; **ambiguous symbols across chains are never auto-resolved** — reply asking which chain.
- [ ] **P6.6** Execute through the existing `RiskManager` → `executeSwapPayload` path. No new execution path; social is an *input surface* only.
- [ ] **P6.7** Reply with outcome + explorer link; notify via `NotificationService` so it lands in-app and on Telegram too.

### 8.3 Confirmation modes
- [ ] **P6.8** Per-account setting: **Confirm-first** (default — reply with a one-time signed deep link, valid 5 min, that opens the prefilled Trade page) or **Auto-execute** (opt-in, hard-capped, requires explicit enablement in settings).

### 8.4 Security — non-negotiable (§10.2)
- [ ] **P6.9** Idempotency on `platform:postId` — replays and re-deliveries can never double-trade.
- [ ] **P6.10** Hard caps: per-trade USD, rolling 24h USD, max trades/hour, enforced *before* execution and independently of `RiskManager`.
- [ ] **P6.11** Prompt-injection containment: post text is **data, never instruction**. The LLM returns a structured intent that is schema-validated; it cannot name a wallet, raise a limit, or select a recipient. Ignore quoted/retweeted content entirely.
- [ ] **P6.12** Full audit trail to `AuditLog`: raw post, parsed intent, authorization decision, execution result.
- [ ] **P6.13** Kill switch — `SOCIAL_TRADING_ENABLED=false` by default; per-account and global disable available at runtime.

---

## 9. Phase 7 — Hardening & ship (3–4 days)

- [ ] **P7.1** Cross-chain E2E per family: create wallet → fund (testnet) → quote → trade → confirm → portfolio reflects it.
- [ ] **P7.2** Adapter conformance suite (`describe.each` over every registered adapter) — the structural guarantee that chain #8 can't half-implement the contract.
- [ ] **P7.3** Lint to zero; remove the P0.3 suppressions.
- [ ] **P7.4** Docs (D10): rewrite `Docs/` for multichain, add `Docs/chains.md` (**"how to add a chain" — descriptor + provider + test, nothing else**), `Docs/social-trading.md`, refresh `Docs/telegram-bot.md`, fix the 6 `sUSDT` → `USDCx` references.
- [ ] **P7.5** Ops: per-chain health metrics, RPC failure alerting, per-chain circuit breaker (one dead RPC must not degrade other chains).
- [ ] **P7.6** Staged rollout — testnet-only → internal wallets on mainnet → per-chain flag flip via `ENABLED_CHAINS`.

---

## 10. Risks & flagged concerns

### 10.1 ARC and Robinhood Chain — external unknowns
Both are new networks. Their RPC stability, whether a DEX with meaningful liquidity exists, and whether a 4337 bundler serves them are facts outside this codebase. **Mitigation:** `ChainDescriptor.tradable` splits *listable* from *tradable*, and `EvmChainAdapter`'s EOA custody mode removes the Pimlico dependency. Worst case they ship as discovery-only entries and become tradable by flipping one boolean once a router exists. **Assumption stated explicitly:** both are EVM-equivalent at the JSON-RPC level. If either is not, it needs its own family, and P4 grows by ~3 days per non-conforming chain.

### 10.2 Social trading is a genuine attack surface
A public post moving real funds invites handle spoofing, reply-chain injection, and replay. §8.4 is the mitigation set and is **not optional** — ship it default-off, confirm-first, hard-capped, with the LLM excluded from the authorization path. My recommendation is to ship confirm-first mode only in v1 and gate auto-execute behind explicit per-account opt-in with a low cap.

### 10.3 The refactor touches every execution path
P1 rewrites the dispatch layer that all trading flows through. **Mitigation:** `chainFamily` stays on the model, defaults preserve today's behaviour exactly, the shim keeps old call signatures working through the phase, and the 225-test suite must stay green at every step. Land P1 behind `ENABLED_CHAINS=stacks:mainnet` first — production behaviour is unchanged until a chain is added to that list.

### 10.4 Discovery data quality
Cross-chain price/liquidity from DEX providers alone is thin and manipulable (a fake pool produces a fake price). Flagged for a decision: either add a market-data provider (CoinGecko/DefiLlama) or clearly label prices as DEX-derived. **Recommendation:** DEX-derived plus a minimum-liquidity threshold before a token is listable, with `isVerified` curated.

### 10.5 Scope
This is 26–34 engineer-days sequentially. P2/P3/P4/P5 parallelise across 2–3 engineers to roughly 3 calendar weeks after P1. **P1 cannot be parallelised or skipped** — every other phase compiles against its types.

---

## 11. Sequencing summary

| Phase | Deliverable | Est. | Depends on |
|---|---|---|---|
| P0 | Stabilize: commit, lint gate, tag | 0.5d | — |
| P1 | 🔑 Chain identity, registries, adapter hierarchy | 3–4d | P0 |
| P2 | Telegram: modular, multichain, button-first | 4–5d | P1 |
| P3 | Solana family + Jupiter | 4–5d | P1 |
| P4 | Celo, ARC, Robinhood + native wrap | 2–3d | P1 |
| P5 | Token discovery + deep-link trade | 4–5d | P1 |
| P6 | Social agent (X + Farcaster) | 5–6d | P1, P5 |
| P7 | Hardening, docs, rollout | 3–4d | all |

**Definition of done:** a user discovers a token on the public `/tokens` page, taps Trade, registers, and completes a swap on any enabled chain — and can do the same by tapping through Telegram or by tagging the bot on X — while every trade routes through one `executeSwapPayload` seam, one `RiskManager` check, and one `NotificationService` fan-out, on any chain that exists as a descriptor file.
