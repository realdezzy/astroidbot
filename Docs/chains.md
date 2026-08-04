# Chains

AstroidBot trades across three chain *families* — Stacks, EVM, and Solana (SVM) — and any number of *networks* within them.

## The two axes

A chain has two identifiers, and conflating them is the mistake this design exists to prevent.

| | What it answers | Examples | Cardinality |
|---|---|---|---|
| **`ChainFamily`** | Which execution shape? | `stacks`, `evm`, `svm` | Few, closed |
| **`ChainId`** | Which network? | `base:mainnet`, `celo:mainnet`, `solana:mainnet` | Many, open |

Base and Celo share a family and differ on network. They sign identically and route through completely different contracts.

**`ChainId` is the registry key.** `ChainFamily` only selects which adapter method a payload dispatches to. Earlier code keyed the registry on family, which silently dropped the second EVM chain registered — no error, no log, and every wallet on it dispatched through the first EVM adapter. `ChainAdapterRegistry.register()` now throws on a duplicate for exactly that reason: a chain that fails to register is indistinguishable from one that was never configured.

## Enabling chains

`ENABLED_CHAINS` is a comma-separated list of ChainIds:

```bash
ENABLED_CHAINS="stacks:mainnet,base:mainnet,solana:mainnet"
```

It defaults to `stacks:mainnet`, so a deployment that sets nothing behaves exactly as it did before multichain support existed.

Misconfiguration is **fatal at startup**, never a silent skip — an unknown ChainId, or an ERC-4337 chain with no `PIMLICO_API_KEY`, stops the process with a message naming the chain.

Per-chain RPC overrides follow a fixed pattern derived from the ChainId:

```bash
RPC_URL_BASE_MAINNET="https://base-mainnet.example/v2/..."
RPC_URL_SOLANA_MAINNET="https://your-solana-rpc.example"
```

## Listable vs. tradable

A chain is **tradable** only when it has a routing DEX configured. Without one it still supports wallets, balances and discovery — `DEXRegistry` simply never offers it a quote.

This matters for new networks whose DEX deployments don't exist or aren't verifiable yet. They ship as listable and become tradable by adding a `dex` block. `solana:devnet` is registered this way, since Jupiter doesn't serve devnet, as is `arc:testnet`, which has no DEX at all yet.

## The built-in catalogue

Every chain this build can describe. Being listed here is inert until `ENABLED_CHAINS` names it.

| ChainId | Family | Native | Tradable | Notes |
|---|---|---|---|---|
| `stacks:mainnet` | stacks | STX | yes | ALEX, Bitflow, Velar |
| `stacks:testnet` | stacks | STX | yes | |
| `ethereum:mainnet` | evm | ETH | yes | Uniswap V3 |
| `base:mainnet` | evm | ETH | yes | Uniswap V3, ERC-4337 custody |
| `base:sepolia` | evm | ETH | yes | |
| `celo:mainnet` | evm | CELO | yes | Uniswap V3, EOA custody |
| `robinhood:mainnet` | evm | ETH | yes | Arbitrum Orbit L2, chain 4663, Uniswap V3 |
| `arc:testnet` | evm | USDC | **no** | Circle's Arc — testnet only, no DEX yet |
| `solana:mainnet` | svm | SOL | yes | Jupiter |
| `solana:devnet` | svm | SOL | **no** | Jupiter doesn't serve devnet |

Two entries deserve explanation.

**Robinhood Chain** is a real Arbitrum Orbit L2 with a real Uniswap V3 deployment. Every address in its descriptor was read back off the chain rather than copied from a listing — `QuoterV2.factory()` and a live pool's `factory()` agree, and `SwapRouter02.WETH9()` matches the wrapped-native address. Note that its bridged dollar, **rUSDC, has 18 decimals**, not the 6 that USDC carries almost everywhere else; assuming 6 misprices every quote by 10¹² while looking entirely reasonable.

**Arc has no mainnet.** Circle's Arc is in public testnet and their docs state mainnet parameters are published separately when available. So there is no `arc:mainnet` descriptor, deliberately: an entry with invented parameters would be accepted by `ENABLED_CHAINS`, wallets would be generated against a chain id that doesn't exist, and the failure would surface as unexplained broadcast errors instead of "that chain isn't supported yet".

## Adding a chain

### An EVM chain, without touching code

For a network whose parameters aren't settled enough to hardcode — a new L2, a chain we can't verify from here — use `CUSTOM_EVM_CHAINS`. No code change, no release:

```bash
ENABLED_CHAINS="stacks:mainnet,arc:mainnet"
CUSTOM_EVM_CHAINS='[{
  "chainId": "arc:mainnet",
  "displayName": "ARC",
  "id": 4242,
  "rpcUrl": "https://rpc.arc.example",
  "nativeSymbol": "ARC",
  "stableSymbol": "USDC",
  "explorerBaseUrl": "https://explorer.arc.example"
}]'
```

Add a `dex` block (`quoter`, `swapRouter`, `feeTiers`) once a Uniswap-V3-family router is confirmed, and the chain becomes tradable.

### An EVM chain, in the catalogue

Write a descriptor in `src/services/chains/descriptors/`, export it from `index.ts`, done. See `celo.ts` — 45 lines of data, no class. `UniswapV3Provider` handles any V3 fork; only the addresses differ.

**If this takes more than a day, the abstraction has failed.** Fix the abstraction rather than paying that cost per chain.

### Custody: ERC-4337 or EOA

| Mode | Batching | Gas | Requires |
|---|---|---|---|
| `erc4337` | Atomic (approve + swap in one UserOperation) | Sponsorable | A bundler serving the chain |
| `eoa` | Sequential, **not atomic** | User pays | Nothing |

`eoa` is the default. Without it, "EVM support" would really mean "support for the chains Pimlico happens to serve".

### A new family

Only when a chain genuinely signs differently — a fourth would be something like Hyperliquid's signed off-chain orders.

1. Add the member to `ChainFamily` in `src/types/chain.ts`.
2. Add a payload arm to `TransactionPayload` plus an `assert…Payload` narrowing function.
3. Add an `execute…Call` method to `ChainAdapter` (optional, like the others).
4. Add a branch to `executeSwapPayload` — the single dispatch point every trade-execution call site goes through.
5. Extend `BaseChainAdapter`. Implement only keypairs, broadcast and receipt-reading; locking, key decryption, `DRY_RUN` and confirmation ageing are inherited.
6. Add the family to the `switch` in `registerChains.ts`.

`SolanaAdapter` is the worked example, and it needed no changes to `crypto.ts` or `KMSService` — both are chain-agnostic.

## Where chain-specific values come from

Never hardcode a symbol. Every chain-dependent value lives on the descriptor:

| Instead of | Use |
|---|---|
| `"STX"` | `descriptor.nativeSymbol` |
| `"USDCx"` | `descriptor.stableSymbol` |
| `6` / `18` | `descriptor.nativeDecimals` |
| An explorer URL | `descriptor.explorerTxUrl(txId)` |

For a wallet row, `src/services/chains/walletChain.ts` resolves all of these: `walletChainId()`, `walletDescriptor()`, `walletNativeSymbol()`, `groupByChainId()`.

Limit orders quoted against a hardcoded `"USDCx"` for months, which no Base provider can route — so every Base order read a price of 0 and could only fire via `forceAfter`. That is the failure mode this table prevents.

## Chain-scoped lookups

`DEXRegistry` methods take a trailing chain scope. **Pass a ChainId whenever the result belongs to one wallet.** A bare family (`"evm"`) still works for legacy callers but matches every EVM DEX on every EVM chain — a Base wallet quoted by a Celo router.

```ts
registry.getBestQuote(tokenIn, tokenOut, amount, "base:mainnet");
registry.getSwappableTokens(false, walletChainId(wallet));
```

Token lists are keyed `chainId:SYMBOL`, so `USDC` on Base and `USDC` on Celo stay distinct entries with distinct contracts.

## The API

`GET /api/chains` returns every registered chain. **No UI hardcodes a chain list** — the web app and Telegram bot both read this, so enabling a chain makes it appear everywhere at once.

## Testing

Every adapter should pass the shared conformance expectations, and each chain family has a test file under `tests/services/chains/`. The regression tests that matter most:

- **two EVM chains registered simultaneously**, each resolving to its own adapter and its own DEX provider (`chainIdentity.test.ts`)
- a malformed address failing at *registration*, not at first quote
- a disabled chain reported by name rather than substituted with a default
