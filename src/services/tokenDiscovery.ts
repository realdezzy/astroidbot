import { DatabaseService } from "./db.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { ChainAdapterRegistry } from "./chains/chainAdapterRegistry.js";
import { logger } from "../utils/logger.js";
import type { ChainId } from "../types/chain.js";

/**
 * Cross-chain token catalogue behind the public discovery pages.
 *
 * Data comes from the registered DEX providers, not a third-party market-data
 * feed. That is a deliberate trade-off with a real downside: a DEX-derived
 * price can be manipulated by anyone willing to seed a shallow pool, so a
 * token is only surfaced once it clears MIN_LIQUIDITY_USD, and `isVerified`
 * stays a curated flag rather than something this sync can set. Callers must
 * present these prices as DEX-derived, not as an authoritative mark.
 */

/**
 * Below this, a quoted price says more about the pool's shallowness than the
 * token's value. Such tokens are still stored (so a direct link resolves) but
 * are excluded from ranked discovery listings.
 */
export const MIN_LIQUIDITY_USD = 1_000;

export interface DiscoveryFilters {
  chainId?: ChainId;
  query?: string;
  sort?: "volume" | "change" | "liquidity" | "symbol";
  page?: number;
  pageSize?: number;
  /** Include tokens under the liquidity floor. Off by default. */
  includeIlliquid?: boolean;
}

export class TokenDiscoveryService {
  private static instance: TokenDiscoveryService;

  static getInstance(): TokenDiscoveryService {
    if (!TokenDiscoveryService.instance) {
      TokenDiscoveryService.instance = new TokenDiscoveryService();
    }
    return TokenDiscoveryService.instance;
  }

  /**
   * Refreshes the catalogue from every tradable registered chain.
   *
   * Driven by the existing runCycle() fan-out rather than its own scheduler —
   * the codebase has exactly one periodic tick on purpose, and adding a second
   * scheduling mechanism for this would be the start of a third.
   */
  async syncAll(): Promise<{ chains: number; tokens: number }> {
    const chains = ChainAdapterRegistry.getInstance().tradable();
    let tokens = 0;

    for (const descriptor of chains) {
      try {
        tokens += await this.syncChain(descriptor.chainId);
      } catch (error) {
        // One chain's RPC being down must not stop the others from syncing.
        logger.warn("Token discovery sync failed for chain", {
          chainId: descriptor.chainId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info("Token discovery sync complete", { chains: chains.length, tokens });
    return { chains: chains.length, tokens };
  }

  async syncChain(chainId: ChainId): Promise<number> {
    const db = DatabaseService.getInstance();
    const registry = DEXRegistry.getInstance();
    const tokens = await registry.getSwappableTokens(false, chainId);

    let synced = 0;
    for (const token of tokens) {
      try {
        const priceUsd = await registry.getTokenPrice(token.symbol, chainId).catch(() => 0);

        await db.prisma.token.upsert({
          where: { chainId_contractId: { chainId, contractId: token.contractId } },
          create: {
            chainId,
            contractId: token.contractId,
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            priceUsd: priceUsd > 0 ? priceUsd : null,
            lastSyncedAt: new Date(),
          },
          update: {
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            // Only overwrite a stored price with a real one. A transient RPC
            // failure returning 0 would otherwise wipe a good price and make
            // the token look worthless on the discovery page.
            ...(priceUsd > 0 ? { priceUsd } : {}),
            lastSyncedAt: new Date(),
          },
        });
        synced++;
      } catch (error) {
        logger.warn("Failed to sync token", {
          chainId,
          contractId: token.contractId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return synced;
  }

  /** Paginated, filterable listing for the public discovery page. */
  async discover(filters: DiscoveryFilters = {}) {
    const db = DatabaseService.getInstance();
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));

    const where: Record<string, unknown> = {};
    if (filters.chainId) where.chainId = filters.chainId;
    if (!filters.includeIlliquid) {
      // Tokens with no liquidity figure yet are kept: absent is "unknown", not
      // "zero", and excluding them would hide every freshly-synced token.
      where.OR = [{ liquidityUsd: null }, { liquidityUsd: { gte: MIN_LIQUIDITY_USD } }];
    }
    if (filters.query) {
      const q = filters.query.trim();
      where.AND = [
        {
          OR: [
            { symbol: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
            { contractId: { contains: q, mode: "insensitive" } },
          ],
        },
      ];
    }

    const orderBy = this.orderFor(filters.sort);

    const [items, total] = await Promise.all([
      db.prisma.token.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.prisma.token.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  private orderFor(sort: DiscoveryFilters["sort"]) {
    switch (sort) {
      case "change":
        return [{ priceChange24h: "desc" as const }];
      case "liquidity":
        return [{ liquidityUsd: "desc" as const }];
      case "symbol":
        return [{ symbol: "asc" as const }];
      case "volume":
      default:
        // Nulls last so freshly-synced tokens with no volume figure yet don't
        // outrank established ones on Postgres' default NULLS FIRST for DESC.
        return [{ volume24h: { sort: "desc" as const, nulls: "last" as const } }];
    }
  }

  async getToken(chainId: ChainId, contractId: string) {
    const db = DatabaseService.getInstance();
    return db.prisma.token.findUnique({
      where: { chainId_contractId: { chainId, contractId } },
    });
  }
}
