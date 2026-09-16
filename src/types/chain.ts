/**
 * Chain identity.
 *
 * Before this module, a chain was a single string — `chainFamily` — and that
 * one identifier was doing two incompatible jobs: naming the *execution shape*
 * (Clarity contract call vs. EVM UserOperation vs. Solana instruction) and
 * naming the *network* a wallet lives on. Base and Celo share the first and
 * differ on the second, so collapsing them lost real information:
 * ChainAdapterRegistry was keyed by family and silently dropped the second EVM
 * adapter, and DEXRegistry.getProvidersForChain("evm") matched every EVM DEX on
 * every EVM chain — a Base wallet could be quoted by a Celo router.
 *
 * So identity is two axes:
 *   - ChainFamily — which adapter method a payload dispatches to. Few, closed.
 *   - ChainId     — which network. Many, open, and the registry key.
 */

/**
 * Execution shape. Adding a member here means a genuinely new *way to sign and
 * submit*, which is rare — not merely a new network.
 */
export type ChainFamily = "stacks" | "evm" | "svm";

/**
 * Network identity, `<network>:<environment>` — "base:mainnet", "celo:mainnet",
 * "solana:mainnet", "stacks:mainnet". This is what `Wallet.chain` already
 * stores (it has been populated with `adapter.chainId()` since the column was
 * added) and what the registries key on.
 */
export type ChainId = string;

/** Per-chain EVM configuration. Consumed only by EvmChainAdapter. */
export interface EvmChainConfig {
  /** Numeric EIP-155 chain id. */
  id: number;
  /** Default RPC endpoint; overridable per deployment via config. */
  defaultRpcUrl: string;
  /**
   * Custody mode.
   *
   * "erc4337" — Safe smart account submitted through a bundler/paymaster, so
   * calls batch atomically (an ERC-20 swap is really "approve + swap") and gas
   * can be sponsored. Requires a bundler that supports the chain.
   *
   * "eoa" — a plain externally-owned account signing transactions directly.
   * No batching (calls are submitted sequentially) and the user pays gas, but
   * it works on any EVM chain including ones no bundler serves yet. Without
   * this mode "EVM support" would really mean "support for chains Pimlico
   * happens to serve".
   */
  custody: "erc4337" | "eoa";
  /** Bundler settings; required when custody is "erc4337". */
  bundler?: {
    provider: "pimlico";
    /** Pimlico's URL slug for this chain, e.g. "base", "base-sepolia". */
    slug: string;
  };
  /** Uniswap-family router addresses. Absent when the chain has no DEX yet. */
  dex?: {
    /** Human name of the DEX, used as the DEXProvider name ("UniswapV3", "Ubeswap"). */
    name: string;
    quoter?: `0x${string}`;
    swapRouter?: `0x${string}`;
    /** Uniswap V2 Router & Factory */
    v2Router?: `0x${string}`;
    v2Factory?: `0x${string}`;
    /** Uniswap Universal Router */
    universalRouter?: `0x${string}`;
    /**
     * V3 factory. Only the indexer needs this — it reads `PoolCreated` logs to
     * discover pools, which is the one thing that can't be derived from the
     * router. Optional so a chain can be tradable without being indexable.
     */
    factory?: `0x${string}`;
    /** Fee tiers to scan when quoting, in hundredths of a bip (500 = 0.05%). */
    feeTiers?: number[];
  };
  /** Explicit ingestion deployments, independent of trading routers. */
  indexerFactories?: { address: `0x${string}`; dexId: string; protocol: "uniswap-v2" | "uniswap-v3" | "aerodrome-v2" | "aerodrome-slipstream" | "uniswap-v4"; deploymentBlock?: bigint }[];
  /** Uniswap V4 core. */
  v4PoolManager?: `0x${string}`;
  /**
   * Uniswap V4 periphery, from Uniswap's official deployments page.
   *
   * V4 swaps cannot be sent by a wallet directly — they execute through the
   * Universal Router, which unlocks the PoolManager. The Quoter is the read
   * side (one call per pool key), and both are per chain (V4 is *not* deployed
   * at identical addresses across chains). Absent means the chain has no V4
   * periphery configured and no V4 execution is offered.
   */
  v4Quoter?: `0x${string}`;
  v4UniversalRouter?: `0x${string}`;
  /**
   * Aerodrome Slipstream — Aerodrome's concentrated-liquidity deployment, and
   * where Base's tokenized-stock liquidity lives.
   *
   * A router is bound to the factory it was constructed with, and Aerodrome has
   * run three CL factories, so a pool is only reachable through the router that
   * points at that pool's factory. Each entry therefore carries its own router
   * and quoter alongside the tick spacings to scan (Slipstream's equivalent of
   * fee tiers). Omit on chains without a Slipstream deployment.
   */
  aerodrome?: {
    slipstream?: {
      factory: `0x${string}`;
      router: `0x${string}`;
      quoter: `0x${string}`;
      tickSpacings: number[];
    }[];
  };
  /** Wrapped native token — needed to route native<->ERC20 swaps. */
  wrappedNative?: `0x${string}`;
  /** Curated token list: symbol -> address. */
  tokens?: Record<string, { address: `0x${string}`; decimals: number; name: string }>;
}

/** Per-chain Solana/SVM configuration. Consumed only by SolanaAdapter. */
export interface SvmChainConfig {
  defaultRpcUrl: string;
  /** Jupiter aggregator API base, if routing through Jupiter. */
  jupiterApiUrl?: string;
  /** Micro-lamports per compute unit added as a priority fee. */
  priorityFeeMicroLamports?: number;
}

/**
 * Everything chain-specific that is *data* rather than *behaviour*.
 *
 * Adding a new EVM chain should mean adding one of these and nothing else —
 * that is the test of whether the abstraction is carrying its weight. See
 * Docs/chains.md.
 */
/**
 * Per-chain Stacks configuration. Consumed only by the indexer.
 *
 * Stacks needs no RPC block here — TransactionService and PortfolioManager
 * read the API URL from config, as they did before descriptors existed. What
 * *is* per-chain is which AMM contracts to watch, and there is no factory to
 * enumerate them from: Stacks DEXs deploy a pool contract per protocol, not
 * per pair, and emit a `print` naming the pair on every swap. So the pools are
 * discovered from the swap events themselves and only the protocol contracts
 * need listing.
 */
export interface StacksChainConfig {
  /** Base URL of the Hiro-compatible API used for event ingestion. */
  apiUrl: string;
  /** AMM contracts whose swap prints are ingested. */
  swapContracts: StacksSwapContract[];
}

export interface StacksSwapContract {
  /** Fully-qualified `SP….contract-name`. */
  contractId: string;
  /**
   * Which protocol this is. Selects the print dialect in printDecoder.ts and
   * is recorded on the pool row.
   *
   * Only the contract list lives here. *How* to read a protocol's prints is
   * code, because the dialects differ in more than field names — ALEX gives a
   * directional action over a canonical pair, Velar gives explicit in/out
   * tokens — and no config shape expresses both without becoming a parser.
   */
  dexId: string;
}

export interface ChainDescriptor {
  chainId: ChainId;
  family: ChainFamily;
  /** Display name for UI surfaces: "Base", "Celo", "Solana". */
  displayName: string;
  /** Ticker of the gas/native asset. Wallet.balance stores this asset. */
  nativeSymbol: string;
  /** Decimals of the native asset, and the fallback when a token's are unknown. */
  nativeDecimals: number;
  /**
   * USD stablecoin used to denominate prices on this chain. Price-trigger
   * logic quotes against it, so it must be a symbol this chain's DEX providers
   * can actually route — limit orders on Base read a price of 0 for months
   * because this was hardcoded to Stacks' "USDCx".
   */
  stableSymbol: string;
  isTestnet: boolean;
  /**
   * False when the chain is discoverable and priceable but has no routing DEX
   * yet. Whether a brand-new network has a live DEX with real liquidity is an
   * external fact we don't control, so listing and trading are separate
   * capabilities: a chain ships as listable and becomes tradable by flipping
   * this once a router exists.
   */
  tradable: boolean;
  explorerTxUrl(txId: string): string;
  explorerAddressUrl(address: string): string;
  /**
   * Per-chain ingestion tuning.
   *
   * The indexer's safety margins are denominated in *blocks*, but what they
   * actually protect is a span of *time* — and block times across the enabled
   * set span two orders of magnitude, from Robinhood's ~100ms to Ethereum's
   * ~12s. One global block count therefore means wildly different guarantees:
   * `INDEXER_CONFIRMATIONS=12` was 144 seconds of reorg protection on Ethereum
   * and 1.2 seconds on Robinhood.
   *
   * Stating the chain's block time here lets those margins be derived rather
   * than guessed. Absent, the global block counts apply unchanged.
   */
  indexer?: IndexerChainConfig;
  evm?: EvmChainConfig;
  svm?: SvmChainConfig;
  stacks?: StacksChainConfig;
}

export interface IndexerChainConfig {
  /**
   * Mean seconds per block. A measured physical property of the chain, not a
   * tuning knob — it is what the time-denominated targets are converted
   * through. Chains whose ingestion isn't block-ranged (Stacks, Solana) may
   * still state it for the health surfaces.
   */
  blockTimeSeconds?: number;
  /**
   * Explicit block count, overriding anything derived from `blockTimeSeconds`.
   * For a chain whose reorg behaviour doesn't follow from its block rate.
   */
  confirmations?: number;
  /** Explicit first-run lookback, overriding the derived value. */
  initialLookbackBlocks?: number;
}

export function requireStacksConfig(d: ChainDescriptor): StacksChainConfig {
  if (d.family !== "stacks" || !d.stacks) {
    throw new Error(`Chain ${d.chainId} has no Stacks indexer configuration`);
  }
  return d.stacks;
}

/** Narrowing helpers — keep the `!` assertions out of adapter code. */
export function requireEvmConfig(d: ChainDescriptor): EvmChainConfig {
  if (d.family !== "evm" || !d.evm) {
    throw new Error(`Chain ${d.chainId} has no EVM configuration`);
  }
  return d.evm;
}

export function requireSvmConfig(d: ChainDescriptor): SvmChainConfig {
  if (d.family !== "svm" || !d.svm) {
    throw new Error(`Chain ${d.chainId} has no SVM configuration`);
  }
  return d.svm;
}

/**
 * The family a bare chainId belongs to, without needing a registered adapter.
 * Used by migration/compat paths that still carry a family string.
 */
export function familyOfChainId(chainId: ChainId): ChainFamily | undefined {
  const network = chainId.split(":")[0];
  if (network === "stacks") return "stacks";
  if (network === "solana") return "svm";
  return undefined;
}
