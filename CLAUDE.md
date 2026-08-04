# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AstroidBot is an AI-driven trading bot originally built for the Stacks blockchain, now expanding to a multi-chain platform (see `Docs/` and the phased roadmap referenced in git history for the full plan). It's exposed through three interfaces that all share the same backend: a Telegram bot (grammY), a REST/WebSocket API (Express v5), and a React web dashboard. It trades across multiple DEXs — Stacks (ALEX, Bitflow, Velar), any Uniswap-V3-family EVM chain, and Solana via Jupiter — through a common `DEXProvider` abstraction, holds user wallets via a chain-dispatched `ChainAdapter` abstraction, and runs both deterministic strategies (grid, DCA, sniper, copy-trade, portfolio rebalance) and optional LLM-driven trading ("agents" in Off/Advisor/Autonomous mode).

## Commands

Scripts are in `package.json` (backend) and `web/package.json` (frontend). The backend serves `web/dist` statically when it exists.

Docker (full stack: Postgres + Redis + bot + indexer): `docker compose up --build -d`. **Two application containers, one image**: `bot` (`docker-entrypoint.sh` → `src/index.ts` — API, Telegram, trading cycle, queue workers) and `indexer` (`docker-entrypoint-indexer.sh` → `src/indexer.ts` — market-data ingestion only). They share Postgres and Redis and nothing else. The `bot` entrypoint runs `npx prisma migrate deploy` on boot, so `prisma/migrations/` is checked in and **is** the deploy path — a schema change needs a migration committed alongside it (`npm run db:migrate` locally), not just an edited `schema.prisma`. This replaced an earlier `prisma db push` entrypoint, which refused any change it deemed risky (it blocked the `Wallet` composite-unique change and crash-looped the container under `set -e`). A database provisioned by that old push path already has the schema and must be baselined once before the first `migrate deploy`, or it will fail trying to re-create existing objects:

```bash
npx prisma migrate resolve --applied 20250620000000_init
npx prisma migrate resolve --applied 20260726120000_multichain_wallets_and_catchup
npx prisma migrate resolve --applied 20260726220000_wallet_chain_index
npx prisma migrate resolve --applied 20260727000000_token_catalogue_and_candle_chain
npx prisma migrate resolve --applied 20260727010000_social_trading
npx prisma migrate resolve --applied 20260802000000_market_data_indexer
```

The `indexer` container deliberately does **not** run `migrate deploy` — two containers racing it on boot is a coin flip Prisma's advisory lock usually wins, and "usually" is not a property to want guarding a schema holding wallet keys. Compose starts it only once `bot` is healthy, which is after migrations have applied. Keep that single-owner rule if you add a third container.

## Architecture

### Two processes
There are exactly two entrypoints, and knowing which one you're editing for matters:

- **`src/index.ts`** — the product. API, WebSocket, Telegram, trading cycle, queue workers.
- **`src/indexer.ts`** — market-data ingestion, nothing else. No API surface beyond `GET /health`, no wallet keys, no queue workers.

Both start with `hardenOutboundHttp()` + `installProcessGuards()` + `connectDatabase()` from `src/runtime.ts`. Those three used to live inside `bootstrap()`; they were pulled out precisely so a second process couldn't skip them. Skipping the first is the expensive one — RPC endpoints behind Cloudflare reject Node's default TLS fingerprint, and an indexer that can't read logs looks like a chain with no swaps rather than like a broken client.

**Ingestion happens in `src/indexer.ts` and nowhere else**, and there is no flag to change that — `runCycle()` has no ingestion call to enable. Don't add one back: a deployment that doesn't want market data doesn't run the container. Table ownership follows the same line and is the invariant to protect — the indexer writes `IndexedPool`/`PoolCandle`/`IndexerCursor`/`IndexedToken` and nothing else; the backend writes `Token` and nothing else; they meet only through `MarketDataProvider`. See `Docs/market-data.md`.

### Startup sequence
`src/index.ts` → `bootstrap()` (`src/bootstrap.ts`) → `createServer()` (`src/api/server.ts`). `bootstrap()` does more than wire services: via `runtime.ts` it globally patches `tls.DEFAULT_CIPHERS`, `axios.defaults`, and `globalThis.fetch` to mimic a browser TLS/User-Agent fingerprint for *all* outbound HTTP in the process (worked around Cloudflare blocking on upstream APIs). Any new outbound HTTP client added anywhere in the codebase inherits this. Bootstrap registers the three Stacks DEX providers into `DEXRegistry` (`AlexDEXService`, `BitflowDEXService`, `VelarDEXService`), then calls `registerEnabledChains()` (`src/services/chains/registerChains.ts`), which registers a `ChainAdapter` and its DEX provider for every ChainId in `ENABLED_CHAINS` (default `stacks:mainnet`). Misconfiguration throws at startup rather than silently skipping a chain. `src/indexer.ts` skips all of that except `registerEnabledChains()` — it needs descriptors to know what's indexable, and the EVM DEX providers because native-USD pricing can fall back to a live router quote.

After `bootstrap()`, `index.ts` registers BullMQ workers (`QueueManager.registerWorker`) for the four queues in `QUEUES` (`src/services/queue.ts`): `trade-execution`, `trade-confirmation`, `strategy-cycle`, `notification`. There is no cron/repeatable-job library in use — scheduling is a single `setInterval` in `index.ts` calling `runCycle()` (`src/engine/cycleOrchestrator.ts`) every `POLL_INTERVAL_SECONDS`. That one global tick fans out to `StrategyEngine.runCycle()`, which enqueues one `strategy-cycle` job per active `(strategy, wallet)` pair (deterministic `jobId` for dedup) — **this is still the pattern for any new periodic feature.** The indexer process has a timer of its own, and that is the one documented exception, bought with a separate process and a cross-process lock; it is not licence for a second timer inside `index.ts`.

### Trade execution path — chain-dispatched
`DEXRegistry` (`src/services/dex/dexRegistry.ts`) aggregates quotes/swap-payload building across providers implementing the `DEXProvider` interface (`src/types/dexProvider.ts`); `getBestQuote`/`getAllQuotes` take an optional chain scope routed through `getProvidersForChain()` so one wallet's quotes never mix with another chain's providers. Every trade-execution call site (`UserController.executeTrade`, `strategyEngine.executeApprovedActions`, `tradeWorker.processTradeJob`, `limitOrder.ts`) resolves the wallet's ChainId via `walletChainId()` (`src/services/chains/walletChain.ts`) and calls `executeSwapPayload()` (`src/services/chains/executeSwap.ts`) rather than `TransactionService` directly — that's the single dispatch point: `payload.kind === "evm"` routes to `ChainAdapterRegistry.get(chainId).executeEvmCall()`, `"svm"` to `executeSvmCall()`, anything else (`kind` undefined/`"stacks"`) asserts the Stacks shape (`assertStacksPayload()`) and calls `TransactionService.execute()` exactly as before. Confirmation polling has the same split via `confirmSwap()` in the same file, used by `confirmWorker.ts` and `cycleOrchestrator.ts`'s pending-trade retry loop — both fetch the trade's wallet to get its ChainId first. `TransactionService` (`src/services/transaction.ts`) itself is unchanged: decrypts the wallet's private key via `KMSService` just-in-time, holds a Redis lock per wallet (`RedisService.acquireLock`) for the duration of signing/broadcast, builds Stacks post-conditions in `PostConditionMode.Deny` for on-chain slippage protection.

`RiskManager` (`src/services/riskManager.ts`) enforces `maxPositionPct`/`dailyLossLimit`/slippage settings, and is wired into every trade-execution entrypoint — agents, strategies, `tradeWorker.ts`, and `UserController.executeTrade`. If you add a new trade-execution entrypoint, call `RiskManager.evaluateTrade`/`evaluateActions` before executing — don't reintroduce the gap.

Chain-sensitive lookups on `DEXRegistry` all take an optional trailing chain scope (`getBestQuote`/`getAllQuotes`/`getSwappableTokens`/`getTokenPrice`/`getCachedTokens`), routed through `getProvidersForChain()`. **Pass a ChainId** wherever the result belongs to one wallet. A bare family (`"evm"`) still resolves, for legacy callers, but matches every EVM DEX on every EVM chain — a Base wallet quoted by a Celo router. Merged token lists are keyed `chainId:symbol` and carry both `chainFamily` and `chainId`, so same-ticker tokens on different chains stay distinct entries.

Prices denominated per chain come from the descriptor, never from constants: `descriptor.nativeSymbol`/`nativeDecimals`/`stableSymbol`/`explorerTxUrl()`. Use `walletChain.ts`'s helpers for a wallet row. `limitOrder.ts`'s price-trigger check uses `stableSymbol` — it previously hardcoded `"USDCx"`, which no Base provider can route, so every Base limit order read a current price of 0 and could only fire via `forceAfter`.

### Chain abstraction & wallets
A chain has **two** identifiers and conflating them is the mistake this design prevents: `ChainFamily` (`stacks`/`evm`/`svm`) says which *execution shape* a payload dispatches to; `ChainId` (`base:mainnet`, `celo:mainnet`, `solana:mainnet`) says which *network*. Base and Celo share a family and differ on network. **`ChainId` is the registry key.** The earlier family-keyed registry silently dropped the second EVM chain registered, so `ChainAdapterRegistry.register()` now throws on a duplicate — a chain that fails to register is indistinguishable from one that was never configured. See `Docs/chains.md`.

Everything chain-specific that is *data* lives in a `ChainDescriptor` (`src/types/chain.ts`), one file per chain under `src/services/chains/descriptors/`. **Adding an EVM chain should be a descriptor and nothing else** — `celo.ts` is 45 lines of data with no class. Chains whose parameters can't be hardcoded (new L2s) are declared entirely through the `CUSTOM_EVM_CHAINS` env var. `descriptor.tradable` separates *listable* (wallets, balances, discovery) from *tradable* (a routing DEX exists).

Adapters form a hierarchy: `BaseChainAdapter` (`baseChainAdapter.ts`) hoists what every family shares — the Redis wallet lock with its ownership token, just-in-time `KMSService` key decryption, `DRY_RUN`, and the "aged out, mark it FAILED" rule. `EvmChainAdapter` holds all EVM behaviour parameterised by the descriptor, and supports **both** ERC-4337 (Safe + Pimlico, atomic batching, sponsorable gas) and plain **EOA** custody — EOA is the default, because otherwise "EVM support" means "support for the chains Pimlico serves". `SolanaAdapter` and `StacksAdapter` are the other two. Subclasses implement only keypairs, broadcast and receipt-reading.

`executeContractCall`/`executeEvmCall`/`executeSvmCall` on `ChainAdapter` are all optional because "execute a trade" has no single shape: a Stacks Clarity call, an EVM to/data/value batch, and a Solana pre-built serialized transaction genuinely differ. A fourth family (e.g. Hyperliquid's signed off-chain orders) adds a fourth. `TransactionPayload` (`src/types.ts`) carries all three shapes, narrowed by `assertStacksPayload()`/`assertSvmPayload()`.

`Wallet` has `chainFamily`/`chain` columns; `chain` holds the ChainId and is authoritative for dispatch. Wallets are created through the adapter: `UserController.generateWallet`/`importWallet` and the Telegram equivalents (`src/bot/callbacks/wallet.ts`) accept a `chainId` (`chainFamily` still accepted for older clients), reject a chain not enabled here, and persist both columns. `db.findWalletByAddress(address, chainFamily?)` must be passed the family for duplicate checks, since the unique key is `[chainFamily, address]`.

`src/utils/crypto.ts` does AES-256-GCM with HKDF-derived keys from `AES_KEY`, chain-agnostic (encrypts any private key string) — reused unchanged for EVM and Solana; no chain has needed a crypto change. `decrypt()` has a silent fallback to a legacy pre-HKDF derivation for old ciphertexts. `KMSService` (`src/services/kms.ts`) is the only caller of encrypt/decrypt for wallet keys. For ERC-4337 wallets the encrypted key is the Safe's *owner* EOA key, not the traded-from address — `Wallet.address` is the Safe's counterfactual address.

### DEX providers
`BaseDEXProvider` holds the price cache and chain identity; `UniswapV3Provider` covers **any** V3 fork on any EVM chain (Base, Celo, anything in `CUSTOM_EVM_CHAINS`) — only addresses differ, and it handles native-asset trades by resolving the native symbol to its wrapped form and bracketing the swap with deposit/withdraw calls. `JupiterProvider` is the Solana aggregator. Providers are named per-chain (`UniswapV3-base:mainnet`) because `DEXRegistry` dedupes by name and would otherwise drop the second chain's provider.

### Market data & the indexer
Everything the discovery surfaces render — price, volume, liquidity, the 5M/1H/6H/24H columns — comes from a `MarketDataProvider` (`src/services/marketData/`). `internal` reads our own swap index and is the production default; `dexscreener` exists to exercise the interface before an index has data; `auto` falls back per chain while one warms up. Production doesn't use DexScreener because it would make someone else's rate limit and uptime load-bearing for our own pages.

The index itself (`src/services/indexer/`) reads `PoolCreated` and `Swap` logs from each chain's V3 factory into `IndexedPool` → `PoolCandle` (5-min OHLCV) → rolled-up `Token` metrics. Raw swaps are never persisted. `UniswapV3Indexer` serves every V3-family chain — adding one is `factory` in its descriptor's `dex` block and nothing else. Read `Docs/market-data.md` before touching it: the ordering of the cursor advance, the refusal to step over unreadable ranges, the split-only-on-oversize retry rule, and the USD-anchor fallback chain each encode a failure that has already happened once.

Two invariants that are easy to break from a distance: **metrics stay nullable end to end** (unknown and zero sort to opposite ends of a volume-ranked table), and **volume accumulates additively**, which is why ingesting a range twice corrupts it permanently and why the per-chain Redis lock exists.

### Token discovery & social trading
`TokenDiscoveryService` (`src/services/tokenDiscovery.ts`) syncs a cross-chain `Token` catalogue from the registered providers, driven by the existing `runCycle()` fan-out — **do not add a second scheduler**. It backs the public, unauthenticated `/api/tokens/discover` routes and the `/tokens` pages, which deep-link into `/trade?chainId=…&tokenOut=…`. The token *set* comes from the DEX providers (what this deployment can actually route); the *metrics* come from the `MarketDataProvider`.

Social trading (`src/services/social/`, `Docs/social-trading.md`) lets a linked X/Farcaster account trade by mention. It is **off by default**. Authorization keys on the platform's immutable user id (never the handle), parsing is a deterministic grammar before any LLM, `SocialIntent` has no field for a wallet or recipient so injection has nowhere to land, commands are idempotent on `[platform, postId]`, and USD caps are enforced before execution independently of `RiskManager`.

### Strategies & agents
Strategy types live under `src/services/strategy/` (rebalance, grid/market-maker, DCA, sniper, copy-trade) and are attached to a `TradeAgent` (Prisma model) with an AI mode: **Off** (strategies only), **Advisor** (AI analyzes and logs `AIRecommendation` but doesn't trade), **Autonomous** (AI executes its own trades). See `Docs/agents.md` for the user-facing behavior spec. `AIOrchestrator` (`src/services/ai.ts`) is the natural-language entry point (used by `/api/ai/command`, `/api/ai/voice`, and Telegram free-text) and is provider-agnostic over OpenAI/Google Gemini/DeepSeek via `AI_PROVIDER`.

### Notifications & real-time updates
`NotificationService.send({ userId, title, message, type })` (`src/services/notificationService.ts`) is the single fan-out point: it persists to the `Notification` table, pushes over WebSocket (`WebSocketManager.broadcastToUser`), and sends a Telegram alert if the user has Telegram linked — one call covers all three surfaces. `WebSocketManager` (`src/api/websocket.ts`) authenticates connections via a JWT query param and exposes typed broadcast helpers (`broadcastTradeEvent`, `broadcastCycleComplete`, etc.) — add new typed helpers here rather than broadcasting raw payloads.

### Config
`ConfigManager` (`src/config.ts`) is a zod-validated singleton over `process.env`. Call `ConfigManager.load()` once at startup (already done in `bootstrap()`); everywhere else use `ConfigManager.getInstance()`. Adding a new env var means adding it to `envSchema` first — accessing it via `.config.FOO` won't typecheck otherwise. Booleans must use the `z.enum(["true","false","1","0"]).transform(...)` shape, **not** `z.coerce.boolean()`: `Boolean("false")` is `true`, so a coerced flag is enabled by the value meant to disable it. `ENABLED_CHAINS` decides which chains this deployment runs (see `Docs/chains.md`).

`npm run lint:gate` is the CI gate: zero errors is hard, and `scripts/lint-ratchet.mjs` holds the remaining warnings at a ceiling that can only fall. Fix new warnings rather than re-baselining.

### Multi-interface auth
Telegram login and email/password login both terminate in the same JWT (`src/api/middleware/auth.ts`, `authController.ts`) — `req.userId` is the common key every controller/service keys off of, regardless of which interface (Telegram, web, REST) originated the request. Refresh tokens are hashed at rest with rotation + reuse detection (reuse revokes all sessions for that user).

### Path alias
`@shared/*` (tsconfig `paths`) maps to `shared/` — types and validation logic meant to be usable from both `src/` and potentially the frontend live there.
