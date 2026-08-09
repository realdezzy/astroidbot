import { DatabaseService } from "../db.js";
import { ChainAdapterRegistry } from "../chains/chainAdapterRegistry.js";
import type { ChainId } from "../../types/chain.js";
import type { MarketDataProvider, TokenMarketData } from "./types.js";

/**
 * Market data from our own swap index.
 *
 * This is the production provider, and the **only** thing in the backend that
 * reads the indexer's tables. It reads what RollupService has already computed
 * onto `IndexedToken`, which means serving it is one indexed query — no
 * third-party call sits in the request path, so a page cannot be slowed down
 * or taken offline by someone else's rate limit.
 *
 * Read-only, in both directions: this provider never writes `IndexedToken`
 * (the indexer process owns it) and never reads `Token` (the backend's own
 * catalogue, which caches what comes back from here). Keeping that boundary in
 * one class is why it is worth having a class at all.
 *
 * It reports only what we actually observed. A chain we don't index returns
 * nothing rather than guessing, which is what `supportsChain` is for.
 */
export class InternalMarketDataProvider implements MarketDataProvider {
  readonly name = "internal";

  supportsChain(chainId: ChainId): boolean {
    // Indexable and enabled are different questions; the registry answers the
    // second, and only enabled chains ever have rows to return.
    return ChainAdapterRegistry.getInstance().has(chainId);
  }

  async getMarketData(
    chainId: ChainId,
    contractIds: string[]
  ): Promise<Map<string, TokenMarketData>> {
    if (contractIds.length === 0) return new Map();

    const db = DatabaseService.getInstance();
    const rows = await db.prisma.indexedToken.findMany({
      where: { chainId, contractId: { in: contractIds } },
    });

    return new Map(rows.map((r) => [r.contractId.toLowerCase(), toMarketData(r)]));
  }

  async search(query: string, chainId?: ChainId): Promise<TokenMarketData[]> {
    const db = DatabaseService.getInstance();
    const q = query.trim();
    if (!q) return [];

    const rows = await db.prisma.indexedToken.findMany({
      where: {
        ...(chainId ? { chainId } : {}),
        OR: [
          { symbol: { contains: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
          { contractId: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: [{ volume24h: { sort: "desc", nulls: "last" } }],
      take: 50,
    });

    return rows.map(toMarketData);
  }

  async topTokens(chainId: ChainId, limit: number): Promise<TokenMarketData[]> {
    const db = DatabaseService.getInstance();
    const rows = await db.prisma.indexedToken.findMany({
      where: { chainId },
      orderBy: [{ volume24h: { sort: "desc", nulls: "last" } }],
      take: limit,
    });

    return rows.map(toMarketData);
  }
}

/** IndexedToken row -> provider shape. Nulls stay null; see TokenMarketData. */
function toMarketData(row: {
  chainId: string;
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
  dexId: string | null;
  priceUsd: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange6h: number | null;
  priceChange24h: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  txnsBuys24h: number | null;
  txnsSells24h: number | null;
  pairCreatedAt: Date | null;
}): TokenMarketData {
  return {
    chainId: row.chainId,
    contractId: row.contractId,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    // Always null: a logo is not something you can read off a chain. The
    // backend keeps its own on Token, and its sync treats null as "no opinion"
    // rather than "clear it".
    logoUrl: null,
    dexId: row.dexId,
    priceUsd: row.priceUsd,
    priceChange5m: row.priceChange5m,
    priceChange1h: row.priceChange1h,
    priceChange6h: row.priceChange6h,
    priceChange24h: row.priceChange24h,
    volume24h: row.volume24h,
    liquidityUsd: row.liquidityUsd,
    marketCapUsd: row.marketCapUsd,
    txnsBuys24h: row.txnsBuys24h,
    txnsSells24h: row.txnsSells24h,
    pairCreatedAt: row.pairCreatedAt,
  };
}
