import { DexScreenerService, type DexScreenerPair } from "../dexScreener.js";
import { findDescriptor } from "../chains/descriptors/index.js";
import type { ChainId } from "../../types/chain.js";
import type { MarketDataProvider, TokenMarketData } from "./types.js";

/**
 * DexScreener's slug for each ChainId we can map.
 *
 * Their API keys on its own chain names, so this table is the boundary between
 * their identifiers and ours. A chain missing from it is unsupported rather
 * than guessed at — sending "arc:testnet" to an API that has never heard of Arc
 * returns a cheerful empty list, which reads as "no tokens" instead of "wrong
 * question", and that mistake is invisible until someone asks why a chain looks
 * dead.
 */
const DEXSCREENER_SLUGS: Record<string, string> = {
  "ethereum:mainnet": "ethereum",
  "base:mainnet": "base",
  "celo:mainnet": "celo",
  "robinhood:mainnet": "robinhood",
  "solana:mainnet": "solana",
  "stacks:mainnet": "stacks",
};

/**
 * Development-only market data.
 *
 * Exists so the MarketDataProvider interface can be exercised end-to-end
 * before the internal index has ingested anything, and so a local dev machine
 * gets a populated discovery page without running an indexer against paid RPC.
 * Production runs `internal` — this provider depends on a third party's
 * uptime, rate limits and chain coverage, none of which we control.
 */
export class DexScreenerMarketDataProvider implements MarketDataProvider {
  readonly name = "dexscreener";

  private readonly api = DexScreenerService.getInstance();

  supportsChain(chainId: ChainId): boolean {
    return chainId in DEXSCREENER_SLUGS;
  }

  async getMarketData(
    chainId: ChainId,
    contractIds: string[]
  ): Promise<Map<string, TokenMarketData>> {
    const out = new Map<string, TokenMarketData>();
    if (contractIds.length === 0 || !this.supportsChain(chainId)) return out;

    const slug = DEXSCREENER_SLUGS[chainId];
    const pairs = await this.api.getPairsForTokens(contractIds).catch(() => []);

    for (const contractId of contractIds) {
      // Restrict to the requested chain before picking a pair: the same
      // address exists on several EVM chains and the deepest pool for it may
      // well be on a different one.
      const onChain = pairs.filter((p) => p.chainId === slug);
      const best = this.api.getBestPairForToken(onChain, contractId);
      if (!best) continue;

      out.set(contractId.toLowerCase(), toMarketData(chainId, contractId, best));
    }

    return out;
  }

  async search(query: string, chainId?: ChainId): Promise<TokenMarketData[]> {
    const pairs = await this.api.searchPairs(query).catch(() => []);

    const slug = chainId ? DEXSCREENER_SLUGS[chainId] : undefined;
    const scoped = slug ? pairs.filter((p) => p.chainId === slug) : pairs;

    return scoped
      .map((pair) => {
        const resolved = chainId ?? chainIdForSlug(pair.chainId);
        if (!resolved) return null;
        return toMarketData(resolved, pair.baseToken.address, pair);
      })
      .filter((t): t is TokenMarketData => t !== null);
  }

  async topTokens(chainId: ChainId, limit: number): Promise<TokenMarketData[]> {
    // DexScreener has no "top tokens by chain" endpoint on the public API, so
    // this provider genuinely cannot rank. Returning [] lets the caller fall
    // back to the catalogue's own ordering rather than showing a wrong one.
    void chainId;
    void limit;
    return [];
  }
}

/** Reverse of DEXSCREENER_SLUGS, restricted to chains this build describes. */
function chainIdForSlug(slug: string): ChainId | undefined {
  for (const [chainId, mapped] of Object.entries(DEXSCREENER_SLUGS)) {
    if (mapped === slug && findDescriptor(chainId)) return chainId;
  }
  return undefined;
}

function toMarketData(
  chainId: ChainId,
  contractId: string,
  pair: DexScreenerPair
): TokenMarketData {
  const nullable = (v: number | undefined): number | null => (v === undefined ? null : v);

  return {
    chainId,
    contractId,
    symbol: pair.baseToken?.symbol,
    name: pair.baseToken?.name,
    logoUrl: pair.info?.imageUrl ?? null,
    dexId: pair.dexId ?? null,
    priceUsd: pair.priceUsd ? parseFloat(pair.priceUsd) : null,
    priceChange5m: nullable(pair.priceChange?.m5),
    priceChange1h: nullable(pair.priceChange?.h1),
    priceChange6h: nullable(pair.priceChange?.h6),
    priceChange24h: nullable(pair.priceChange?.h24),
    volume24h: nullable(pair.volume?.h24),
    liquidityUsd: nullable(pair.liquidity?.usd),
    marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
    txnsBuys24h: nullable(pair.txns?.h24?.buys),
    txnsSells24h: nullable(pair.txns?.h24?.sells),
    pairCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : null,
  };
}
