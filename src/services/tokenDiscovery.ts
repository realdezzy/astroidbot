import { DatabaseService } from "./db.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { ChainAdapterRegistry } from "./chains/chainAdapterRegistry.js";
import { resolveMarketDataProvider } from "./marketData/index.js";
import { logger } from "../utils/logger.js";
import type { MarketDataProvider } from "./marketData/types.js";
import type { ChainId } from "../types/chain.js";

/**
 * Cross-chain token catalogue behind the public discovery pages.
 *
 * **This service is the only writer of `Token`.** The indexer process writes
 * `IndexedToken` and never touches this table; everything the indexer knows
 * arrives here through a `MarketDataProvider` read. One writer per table is
 * what makes a row's contents attributable to a single pass — with two
 * processes upserting the same row, identity and metrics could come from
 * different moments and nothing downstream could tell.
 *
 * The catalogue is fed from two places:
 *
 *  - **DEX provider token lists** — what this deployment can actually route a
 *    trade through. A much better listing rule than "whatever a market API
 *    returns", and the only source for families with no indexer (Stacks,
 *    Solana).
 *  - **Promotion from `IndexedToken`** — tokens the indexer has seen trade but
 *    that appear in no curated list. That long tail is the entire reason to
 *    run an indexer, and without this step it would be indexed and invisible.
 */

export const MIN_LIQUIDITY_USD = 1_000;

export interface DiscoveryFilters {
  chainId?: ChainId;
  query?: string;
  category?: "trending" | "gainers" | "new" | "all";
  sort?: "volume" | "change" | "liquidity" | "symbol" | "mcap";
  page?: number;
  pageSize?: number;
  /** Include tokens under the liquidity floor. Off by default. */
  includeIlliquid?: boolean;
  /**
   * Include chains flagged `isTestnet`. Off by default — testnet tokens have
   * meaningless prices and would otherwise sort straight into the top of a
   * volume-ranked table alongside real ones.
   */
  includeTestnets?: boolean;
}

/**
 * Includes a column in a Prisma write only when there is a value for it.
 *
 * The distinction this preserves: "the provider returned null" must leave a
 * previously-good stored value alone, not overwrite it with null. Spreading an
 * empty object is how a partial update stays partial.
 */
function defined<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

export class TokenDiscoveryService {
  private static instance: TokenDiscoveryService;

  private provider: MarketDataProvider | null = null;

  static getInstance(): TokenDiscoveryService {
    if (!TokenDiscoveryService.instance) {
      TokenDiscoveryService.instance = new TokenDiscoveryService();
    }
    return TokenDiscoveryService.instance;
  }

  /** Resolved lazily: config isn't loaded when the singleton is constructed. */
  marketData(): MarketDataProvider {
    if (!this.provider) this.provider = resolveMarketDataProvider();
    return this.provider;
  }

  /** Test seam for installing a stub provider. */
  setMarketDataProvider(provider: MarketDataProvider | null): void {
    this.provider = provider;
  }

  async syncAll(): Promise<{ chains: number; tokens: number; promoted: number }> {
    const chains = ChainAdapterRegistry.getInstance().tradable();
    let tokens = 0;
    let promoted = 0;

    for (const descriptor of chains) {
      try {
        tokens += await this.syncChain(descriptor.chainId);
        promoted += await this.promoteIndexedTokens(descriptor.chainId);
      } catch (error) {
        logger.warn("Token discovery sync failed for chain", {
          chainId: descriptor.chainId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info("Token discovery sync complete", { chains: chains.length, tokens, promoted });
    return { chains: chains.length, tokens, promoted };
  }

  /**
   * Copies tokens the indexer has seen trade into the catalogue.
   *
   * A read from the indexer's table and a write to ours — the boundary this
   * whole split exists to hold. Before it, the indexer created `Token` rows
   * directly and an on-chain `symbol()` read could land in a row a curator had
   * just edited.
   *
   * Identity is copied once, on creation. Metrics are left to `syncChain`,
   * which already refreshes every catalogued token, so a promoted token's
   * numbers arrive on the following pass rather than being written twice here.
   *
   * The liquidity floor is what keeps this from being a firehose: the indexer
   * catalogues every token with a pool, including the scams and the test
   * deployments, and the catalogue is a listing decision.
   */
  private async promoteIndexedTokens(chainId: ChainId): Promise<number> {
    const db = DatabaseService.getInstance();

    const indexed = await db.prisma.indexedToken.findMany({
      where: {
        chainId,
        liquidityUsd: { gte: MIN_LIQUIDITY_USD },
        // No rollup yet means no liquidity reading either, so the floor above
        // can't be trusted to have been applied to real numbers.
        lastRolledUpAt: { not: null },
      },
      select: { contractId: true, symbol: true, name: true, decimals: true },
      orderBy: { volume24h: { sort: "desc", nulls: "last" } },
      take: 500,
    });

    if (indexed.length === 0) return 0;

    const existing = await db.prisma.token.findMany({
      where: { chainId, contractId: { in: indexed.map((t) => t.contractId) } },
      select: { contractId: true },
    });
    const known = new Set(existing.map((t) => t.contractId));

    const missing = indexed.filter((t) => !known.has(t.contractId));
    if (missing.length === 0) return 0;

    const { count } = await db.prisma.token.createMany({
      data: missing.map((t) => ({
        chainId,
        contractId: t.contractId,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
      })),
      // A concurrent request could have created the row between the read and
      // the write; losing that race is fine.
      skipDuplicates: true,
    });

    if (count > 0) logger.info("Promoted indexed tokens into catalogue", { chainId, count });
    return count;
  }

  async syncChain(chainId: ChainId): Promise<number> {
    const db = DatabaseService.getInstance();
    const registry = DEXRegistry.getInstance();
    const provider = this.marketData();

    const listed = await registry.getSwappableTokens(false, chainId);

    // Catalogued tokens that appear in no provider list — the ones promoted
    // out of the index. They need their metrics refreshed on the same pass, or
    // a promoted token's row would hold identity and nothing else forever:
    // listed on the discovery page with every number blank.
    const listedIds = new Set(listed.map((t) => t.contractId.toLowerCase()));
    const promoted = await db.prisma.token.findMany({
      where: { chainId },
      select: { contractId: true, symbol: true, name: true, decimals: true },
      orderBy: { volume24h: { sort: "desc", nulls: "last" } },
      take: 500,
    });

    const tokens = [
      ...listed.map((t) => ({ ...t, routable: true })),
      ...promoted
        .filter((t) => !listedIds.has(t.contractId.toLowerCase()))
        .map((t) => ({ ...t, routable: false })),
    ];

    if (tokens.length === 0) return 0;

    // One batched call for the whole chain rather than one per token.
    const metrics = await provider
      .getMarketData(
        chainId,
        tokens.map((t) => t.contractId)
      )
      .catch((error) => {
        logger.warn("Market data lookup failed; syncing identity only", {
          chainId,
          provider: provider.name,
          error: error instanceof Error ? error.message : String(error),
        });
        return new Map<string, import("./marketData/types.js").TokenMarketData>();
      });

    let synced = 0;
    for (const token of tokens) {
      try {
        const market = metrics.get(token.contractId.toLowerCase());

        // Fall back to a DEX-derived spot price only when the provider has no
        // price at all. It's a live quote with no history behind it, which is
        // why it can't populate the change/volume columns. Only for routable
        // tokens: quoting one that is in no provider list is a guaranteed
        // round trip to "no route", several hundred times per pass.
        const priceUsd =
          market?.priceUsd ??
          (token.routable
            ? await registry.getTokenPrice(token.symbol, chainId).catch(() => 0)
            : 0);

        // Identity always refreshes; metrics only overwrite when the provider
        // actually returned one. A null must not clobber a good stored value —
        // that's how a transient upstream blip erases a whole chain's numbers.
        const identity = {
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          lastSyncedAt: new Date(),
        };

        const marketFields = {
          ...defined("priceUsd", priceUsd && priceUsd > 0 ? priceUsd : undefined),
          ...defined("logoUrl", market?.logoUrl ?? undefined),
          ...defined("dexId", market?.dexId ?? undefined),
          ...defined("priceChange5m", market?.priceChange5m ?? undefined),
          ...defined("priceChange1h", market?.priceChange1h ?? undefined),
          ...defined("priceChange6h", market?.priceChange6h ?? undefined),
          ...defined("priceChange24h", market?.priceChange24h ?? undefined),
          ...defined("volume24h", market?.volume24h ?? undefined),
          ...defined("liquidityUsd", market?.liquidityUsd ?? undefined),
          ...defined("marketCapUsd", market?.marketCapUsd ?? undefined),
          ...defined("txnsBuys24h", market?.txnsBuys24h ?? undefined),
          ...defined("txnsSells24h", market?.txnsSells24h ?? undefined),
          ...defined("pairCreatedAt", market?.pairCreatedAt ?? undefined),
        };

        await db.prisma.token.upsert({
          where: { chainId_contractId: { chainId, contractId: token.contractId } },
          create: {
            chainId,
            contractId: token.contractId,
            ...identity,
            ...marketFields,
          },
          update: { ...identity, ...marketFields },
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

    if (filters.chainId) {
      where.chainId = filters.chainId;
    } else if (!filters.includeTestnets) {
      // Hide testnets unless asked for. Their prices are arbitrary, so with a
      // volume-ranked default sort they would otherwise colonise the top of
      // the table. An explicit chainId always wins — asking for a testnet by
      // name is unambiguous.
      const mainnets = ChainAdapterRegistry.getInstance()
        .list()
        .filter((d) => !d.isTestnet)
        .map((d) => d.chainId);

      if (mainnets.length > 0) where.chainId = { in: mainnets };
    }

    if (!filters.includeIlliquid) {
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

    if (filters.category === "new") {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000);
      where.pairCreatedAt = { gte: sevenDaysAgo };
    }

    const sortOption = filters.category === "trending"
      ? "volume"
      : filters.category === "gainers"
      ? "change"
      : filters.category === "new"
      ? "new"
      : filters.sort;

    const orderBy = this.orderFor(sortOption);

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

  private orderFor(sort?: string) {
    switch (sort) {
      case "change":
        return [{ priceChange24h: { sort: "desc" as const, nulls: "last" as const } }];
      case "liquidity":
        return [{ liquidityUsd: { sort: "desc" as const, nulls: "last" as const } }];
      case "mcap":
        return [{ marketCapUsd: { sort: "desc" as const, nulls: "last" as const } }];
      case "symbol":
        return [{ symbol: "asc" as const }];
      case "new":
        return [{ pairCreatedAt: { sort: "desc" as const, nulls: "last" as const } }];
      case "volume":
      default:
        return [{ volume24h: { sort: "desc" as const, nulls: "last" as const } }];
    }
  }

  async getToken(chainId: ChainId, contractId: string) {
    const db = DatabaseService.getInstance();
    let token = await db.prisma.token.findFirst({
      where: {
        chainId,
        contractId: { equals: contractId, mode: "insensitive" },
      },
    });

    if (!token) {
      const registry = DEXRegistry.getInstance();
      const swappables = await registry.getSwappableTokens(false, chainId).catch(() => []);
      const match = swappables.find(
        (t) =>
          t.contractId.toLowerCase() === contractId.toLowerCase() ||
          t.symbol.toLowerCase() === contractId.toLowerCase()
      );

      if (match) {
        const spotPrice = await registry.getTokenPrice(match.symbol, chainId).catch(() => 0);
        token = await db.prisma.token.upsert({
          where: { chainId_contractId: { chainId, contractId: match.contractId } },
          create: {
            chainId,
            contractId: match.contractId,
            symbol: match.symbol,
            name: match.name,
            decimals: match.decimals,
            priceUsd: spotPrice > 0 ? spotPrice : null,
          },
          update: {
            priceUsd: spotPrice > 0 ? spotPrice : undefined,
          },
        });
      }
    }

    return token;
  }
}

