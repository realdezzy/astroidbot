# Market data & the token indexer

Everything the discovery pages show — price, volume, liquidity, transaction counts, the 5M/1H/6H/24H columns — comes from a `MarketDataProvider`. There are two, and they are not peers.

| Provider | What it is | When to use it |
|---|---|---|
| `internal` | Our own swap-event index | **Production.** The default. |
| `dexscreener` | A third-party API | Development only, to exercise the interface before an index has data. |
| `auto` | `internal`, falling back to DexScreener per chain | The window while a newly-enabled chain warms up. |

```bash
MARKET_DATA_PROVIDER="internal"
```

The reason production doesn't use DexScreener is not that it's inaccurate — it's that it makes someone else's rate limit, uptime and chain coverage load-bearing for our own product surface. `auto` exists because a freshly-enabled chain's index starts empty and a page that's blank for a day looks broken; it is a migration aid, not an end state.

## How the index works

One pass per `runCycle()` tick. There is no second scheduler — the codebase has exactly one timer by design.

```
PoolCreated logs ──► IndexedPool ──┐
                                   ├──► PoolCandle (5-min OHLCV) ──► Token metrics
Swap logs ─────────────────────────┘
```

**Pool discovery** reads `PoolCreated` from each chain's Uniswap V3 factory. Only pools with a *priceable* side — the wrapped native or a curated stable — are recorded. Ethereum has hundreds of thousands of V3 pools and a token with no route to a priceable asset has no USD price to report anyway, so this bounds the table by the same rule that decides what we can actually answer questions about.

Discovery also catalogues the traded side of each new pool. Without that the catalogue would only ever contain the handful of tokens hardcoded in each descriptor, since that's all `getSwappableTokens` knows — and the long tail that wasn't hardcoded anywhere is the entire point of running an indexer.

**Swap ingestion** reads `Swap` logs for tracked pools, values each one in USD, and folds them into 5-minute buckets. Raw swaps are deliberately never persisted: a busy chain emits millions a day, nothing the UI asks needs finer resolution than the 5M column it draws, and aggregating first collapses that to 288 rows per pool per day.

**Rollup** turns candles into the numbers the table renders — one SQL statement per chain. Volume and transaction counts sum across all of a token's pools; price and percentage changes come from the single deepest pool, because averaging a deep pool with a dust pool moves the quoted price toward one nobody can trade at.

## Properties worth knowing

**Exactly-once.** Candle writes and the cursor advance commit in one transaction. Volume accumulates additively, so a range applied twice would inflate it — the transaction makes that state unreachable.

**Reorg-safe.** Ingestion stops `INDEXER_CONFIRMATIONS` blocks behind the head, so the cursor never advances past history that can still be rewritten.

**Gaps are retried, not skipped.** If a block range can't be read, the cursor stops *before* it rather than stepping over it. Advancing regardless would drop those swaps permanently, and the resulting gap is invisible — the numbers would simply be quietly wrong.

**Adaptive range splitting.** Providers cap responses by result *count*, not block range, so no fixed chunk size is safe: a range that's fine on a quiet day fails during a volume spike. Oversized results halve the range and retry.

Only oversized results, though. An earlier version split on *any* failure, on the theory that error wordings vary too much to classify. Against a slow endpoint that turned one timeout into a recursive storm of single-block retries — thousands of requests aimed at a provider already struggling, which guaranteed the timeouts continued. A timeout means "ask less often", not "ask for less, immediately, many times over". Transient failures now get one backed-off retry and are then left for the next tick.

**Block timestamps are interpolated.** Asking the chain for every block a swap landed in is thousands of round trips per tick and dominated everything else the indexer did. `BlockTimeOracle` samples a bounded number of blocks per range and interpolates, making the cost constant in range size rather than linear. The timestamp's only job is to place a swap in a five-minute bucket, so a few seconds of error is immaterial — and a misplaced swap lands in an adjacent bucket at worst, never lost or mispriced, since price and volume come from the log itself.

## USD anchoring

Nearly every EVM pool quotes against the wrapped native, so without a USD price for it no swap on the chain has a dollar value and the volume column is uniformly zero.

It can't always be answered locally. **Robinhood Chain has no WETH/rUSDC pool at any fee tier** — there is no on-chain path from ETH to a dollar anywhere on that chain. `resolveNativeUsd` therefore tries, in order:

1. The deepest local native/stable pool. Most accurate where it exists.
2. **The same asset priced on another indexed chain.** ETH is ETH — its dollar price is a global fact, and a deep Ethereum pool is a far better estimate for Robinhood's WETH than a thin local pool would be.
3. A live quote through the chain's own router.

If all three fail it returns null and logs why, rather than defaulting to a number. A wrong anchor misprices every token on the chain by the same factor, which is much harder to notice than a missing one. Trades we saw but couldn't value are reported as **unknown** volume, not zero — zero claims the token didn't trade, and the two sort to opposite ends of a volume-ranked table.

For the same reason, anchor pools are exempt from `INDEXER_MAX_POOLS_PER_CHAIN`. The cap exists to bound work, not to decide what we can price.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MARKET_DATA_PROVIDER` | `internal` | `internal` \| `dexscreener` \| `auto` |
| `INDEXER_ENABLED` | `true` | Off for workers that only execute trades |
| `INDEXER_CONFIRMATIONS` | `12` | Blocks kept behind the head |
| `INDEXER_BLOCK_CHUNK_SIZE` | `2000` | Blocks per `eth_getLogs` |
| `INDEXER_MAX_BLOCKS_PER_RUN` | `20000` | Ceiling per tick, so catch-up can't stall a cycle |
| `INDEXER_INITIAL_LOOKBACK_BLOCKS` | `50000` | Where a fresh chain starts — not a full backfill |
| `INDEXER_MAX_POOLS_PER_CHAIN` | `300` | Tracked pools, most-recently-active first |
| `INDEXER_MAX_ADDRESSES_PER_FILTER` | `100` | Providers reject very large address arrays |
| `INDEXER_MAX_SPLIT_DEPTH` | `12` | Halvings before a range is abandoned |
| `INDEXER_RETRY_BACKOFF_MS` | `1000` | Pause before the single transient retry |
| `INDEXER_MIN_POOL_LIQUIDITY_USD` | `1000` | Below this, activity counts but the price isn't trusted |
| `INDEXER_CANDLE_RETENTION_DAYS` | `30` | Candles older than this are pruned |

The indexer is by far the heaviest RPC consumer in the process. Point each chain at a paid endpoint via the per-chain override — `RPC_URL_ETHEREUM_MAINNET`, `RPC_URL_BASE_MAINNET`, and so on. Public endpoints rate-limit hard, and Ethereum mainnet in particular is not practical to index through one.

## Which chains are indexed

A chain is indexable when it is EVM-family **and** its `dex` block carries a `factory`. Today that is five — four mainnets plus one testnet:

| ChainId | V3 factory |
|---|---|
| `ethereum:mainnet` | `0x1F98431c8aD98523631AE4a59f267346ea31F984` |
| `base:mainnet` | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` |
| `base:sepolia` | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` |
| `celo:mainnet` | `0xAfE208a311B21f13EF87E33A90049fC17A7acDEc` |
| `robinhood:mainnet` | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |

Each was read back off its own chain rather than copied from a listing — `QuoterV2.factory()` on that chain returns the address above.

The remaining chains are not indexed and it isn't a misconfiguration: `arc:testnet` has no DEX at all, and `stacks:*` / `solana:*` are different families needing different ingestion.

## Adding a chain to the index

Add `factory` to the chain's `dex` block in its descriptor. That's the whole change — `UniswapV3Indexer` serves every V3-family deployment, because they all emit byte-identical `PoolCreated` and `Swap` logs. A chain without a factory is skipped quietly; being un-indexable is a normal state, not a misconfiguration.

Solana and Stacks need genuinely different ingestion and would each add a `ChainIndexer` implementation. The interface is in `src/services/indexer/types.ts`.

## Trading a discovered token

Discovery surfaces tokens that were never in any curated list, each with a Trade button, so `UniswapV3Provider.resolveToken` **reads an unknown token's `decimals()` from its contract** rather than assuming 18.

That assumption was safe while only curated tokens were reachable and stopped being safe the moment discovery shipped: `decimals` scales the amount actually spent, so treating a 6-decimal token as 18-decimal turns "swap 1 token" into a request to spend 10¹² times more. A token whose `decimals()` can't be read now fails to resolve — "no route" is a cheap failure, a wrong scale factor is not. Results are cached permanently, since an ERC-20's decimals cannot change.
