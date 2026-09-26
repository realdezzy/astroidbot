import {
  GeckoTerminalService,
  geckoChainIdFor,
  geckoNetworkFor,
  type GeckoPool,
  type GeckoTokenMetrics,
} from "../geckoTerminal.js";
import { findDescriptor } from "../chains/descriptors/index.js";
import type { ChainId } from "../../types/chain.js";
import type { MarketDataProvider, TokenMarketData } from "./types.js";

/**
 * Market data from GeckoTerminal / CoinGecko onchain.
 *
 * The external half of the hybrid: our own index still discovers pools and
 * measures their liquidity on-chain, but price, volume and the change columns
 * come from here. The trade this makes is deliberate — it puts a third party's
 * rate limit back in the request path, which is exactly what the internal
 * provider was built to avoid, and buys back the several thousand lines of
 * swap ingestion, reorg handling and rollup that were computing numbers this
 * API already computes correctly.
 *
 * Deploy it behind `hybrid` rather than alone unless you mean to have no
 * fallback: `hybrid` is this provider with DexScreener behind it, composed
 * through the same `FallbackMarketDataProvider` `auto` already uses.
 */
export class GeckoTerminalMarketDataProvider implements MarketDataProvider {
  readonly name = "geckoterminal";

  private readonly api = GeckoTerminalService.getInstance();

  supportsChain(chainId: ChainId): boolean {
    return geckoNetworkFor(chainId) !== null;
  }

  async getMarketData(
    chainId: ChainId,
    contractIds: string[]
  ): Promise<Map<string, TokenMarketData>> {
    const out = new Map<string, TokenMarketData>();
    if (contractIds.length === 0 || !this.supportsChain(chainId)) return out;

    const { tokens, pools } = await this.api.tokenMetrics(chainId, contractIds);
    const deepest = deepestPoolByToken(pools);

    for (const token of tokens) {
      out.set(
        token.address.toLowerCase(),
        toMarketData(chainId, token, deepest.get(token.address.toLowerCase()))
      );
    }

    return out;
  }

  /**
   * Free-text search, answered through the pool search.
   *
   * The API searches pools rather than tokens, so results are folded back onto
   * each pool's base token — which is also the side a user searching a ticker
   * means. A pool whose chain this build doesn't describe is dropped rather
   * than mapped to a guess.
   */
  async search(query: string, chainId?: ChainId): Promise<TokenMarketData[]> {
    const pools = await this.api.searchPools(query, chainId);

    const out = new Map<string, TokenMarketData>();

    for (const pool of pools) {
      if (!pool.baseTokenAddress) continue;

      const resolved = chainId ?? chainIdForPool(pool);
      if (!resolved) continue;

      const key = `${resolved}:${pool.baseTokenAddress}`;
      const existing = out.get(key);

      // Several pools for one token come back; the deepest describes it, the
      // same rule the rollup uses. Averaging a deep pool with a dust pool
      // moves the quoted price toward one nobody can trade at.
      if (existing && (existing.liquidityUsd ?? 0) >= (pool.reserveUsd ?? 0)) continue;

      out.set(key, fromPool(resolved, pool));
    }

    return [...out.values()];
  }

  /**
   * The most active tokens on a chain.
   *
   * There is no "top tokens" endpoint, so this ranks the base tokens of the
   * chain's newest pools — which answers "what is trading now" rather than
   * "what is biggest". A caller wanting the catalogue's own ordering gets it
   * by this returning fewer rows than asked for, which is the same contract
   * the DexScreener provider honours by returning none.
   */
  async topTokens(chainId: ChainId, limit: number): Promise<TokenMarketData[]> {
    if (!this.supportsChain(chainId)) return [];

    const pools = await this.api.newPools(chainId);
    const byToken = new Map<string, GeckoPool>();

    for (const pool of pools) {
      if (!pool.baseTokenAddress) continue;
      const existing = byToken.get(pool.baseTokenAddress);
      if (!existing || (pool.reserveUsd ?? 0) > (existing.reserveUsd ?? 0)) {
        byToken.set(pool.baseTokenAddress, pool);
      }
    }

    return [...byToken.values()]
      .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
      .slice(0, limit)
      .map((pool) => fromPool(chainId, pool));
  }
}

/** The deepest pool per base token, which is the one that describes it. */
function deepestPoolByToken(pools: GeckoPool[]): Map<string, GeckoPool> {
  const out = new Map<string, GeckoPool>();

  for (const pool of pools) {
    if (!pool.baseTokenAddress) continue;
    const key = pool.baseTokenAddress.toLowerCase();
    const existing = out.get(key);
    if (!existing || (pool.reserveUsd ?? 0) > (existing.reserveUsd ?? 0)) out.set(key, pool);
  }

  return out;
}

/**
 * The ChainId for a pool's network, restricted to chains this build describes.
 *
 * An unscoped search returns pools from every network at once, so a result
 * whose network we can't map is dropped rather than attributed to the chain
 * the caller happened to be looking at — the same mistake as assuming an
 * address seen on Base is the Base token, which it need not be.
 */
function chainIdForPool(pool: GeckoPool): ChainId | null {
  if (!pool.network) return null;

  const chainId = geckoChainIdFor(pool.network);
  return chainId && findDescriptor(chainId) ? chainId : null;
}

/**
 * Token metrics plus its deepest pool, as one row.
 *
 * Every field the pool would supply stays null when there is no pool: the 5M
 * column of a token we could price but not attribute to a pool is unknown, not
 * zero, and the two sort to opposite ends of a table.
 */
function toMarketData(
  chainId: ChainId,
  token: GeckoTokenMetrics,
  pool: GeckoPool | undefined
): TokenMarketData {
  return {
    chainId,
    contractId: token.address,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    logoUrl: token.imageUrl,
    dexId: pool?.dexId ?? null,
    priceUsd: token.priceUsd,
    priceChange5m: pool?.priceChange5m ?? null,
    priceChange1h: pool?.priceChange1h ?? null,
    priceChange6h: pool?.priceChange6h ?? null,
    priceChange24h: pool?.priceChange24h ?? null,
    volume24h: token.volume24h,
    liquidityUsd: token.liquidityUsd,
    marketCapUsd: token.marketCapUsd,
    txnsBuys24h: pool?.buys24h ?? null,
    txnsSells24h: pool?.sells24h ?? null,
    pairCreatedAt: pool?.createdAt ?? null,
  };
}

/** A search or new-pools hit, which knows a pool but never the token's identity. */
function fromPool(chainId: ChainId, pool: GeckoPool): TokenMarketData {
  return {
    chainId,
    contractId: pool.baseTokenAddress ?? pool.address,
    // The pool's name is "WETH / USDC 0.05%"; the base token is the first
    // segment. Wrong-looking enough to be worth saying: this is the only
    // identity a pool-shaped response carries.
    symbol: pool.name?.split("/")[0]?.trim() || undefined,
    logoUrl: null,
    dexId: pool.dexId,
    priceUsd: pool.priceUsd,
    priceChange5m: pool.priceChange5m,
    priceChange1h: pool.priceChange1h,
    priceChange6h: pool.priceChange6h,
    priceChange24h: pool.priceChange24h,
    volume24h: pool.volume24h,
    liquidityUsd: pool.reserveUsd,
    marketCapUsd: null,
    txnsBuys24h: pool.buys24h,
    txnsSells24h: pool.sells24h,
    pairCreatedAt: pool.createdAt,
  };
}
