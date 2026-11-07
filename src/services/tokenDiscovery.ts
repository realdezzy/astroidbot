import { DatabaseService } from "./db.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { ChainAdapterRegistry } from "./chains/chainAdapterRegistry.js";
import { marketDataIsExternal, resolveMarketDataProvider } from "./marketData/index.js";
import { stocksForChain } from "./stocks/stockRegistry.js";
import { EquityPriceOracle } from "./stocks/chainlink.js";
import { ConfigManager } from "../config.js";
import { logger } from "../utils/logger.js";
import type { MarketDataProvider, TokenMarketData } from "./marketData/types.js";
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

export const MIN_LIQUIDITY_USD = 10;

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
   * Restrict to one asset class. Absent means no restriction, which is the
   * historical behaviour — a caller that predates asset classes is unaffected.
   */
  assetClass?: "CRYPTO" | "EQUITY";
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

/**
 * The metric columns, explicitly nulled.
 *
 * A spread of `undefined` cannot express "this is no longer known" — that is
 * the point of `defined()` above. Clearing stale external-provider numbers
 * needs the opposite operation, so it is spelled out rather than inferred.
 * Immutable identity (`pairCreatedAt`, `logoUrl`, `dexId`) is deliberately not
 * cleared: when a pool was created does not go stale the way a price does.
 */
const CLEARED_METRICS = {
  priceUsd: null,
  priceChange5m: null,
  priceChange1h: null,
  priceChange6h: null,
  priceChange24h: null,
  volume24h: null,
  liquidityUsd: null,
  marketCapUsd: null,
  txnsBuys24h: null,
  txnsSells24h: null,
} as const;

/** Whether a provider row carries any metric at all, as opposed to identity only. */
function hasMetrics(market: TokenMarketData | undefined): boolean {
  if (!market) return false;
  return [
    market.priceUsd,
    market.priceChange5m,
    market.priceChange1h,
    market.priceChange6h,
    market.priceChange24h,
    market.volume24h,
    market.liquidityUsd,
    market.marketCapUsd,
    market.txnsBuys24h,
    market.txnsSells24h,
  ].some((value) => value !== null && value !== undefined);
}

export interface TokenSyncResult {
  chains: number;
  tokens: number;
  promoted: number;
  stocks: number;
}

export class TokenDiscoveryService {
  private static instance: TokenDiscoveryService;

  private provider: MarketDataProvider | null = null;

  /** Deduplicates overlapping ticks; a slow external sync can outlive 60s. */
  private syncInFlight: Promise<TokenSyncResult> | null = null;

  /** When the last catalogue sync started, for the interval throttle. */
  private lastSyncAt = 0;

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

  /**
   * Catalogue refresh on the global tick.
   *
   * Throttled and single-flight: the tick is 60s, but GeckoTerminal's keyless
   * budget is 30 calls/minute shared with search, candles and trades. A sync
   * that ran every tick would spend the whole budget on the catalogue and
   * starve the pages; two that overlap would double the call rate.
   */
  async syncIfDue(): Promise<TokenSyncResult | null> {
    const intervalMs =
      ConfigManager.getInstance().config.MARKET_DATA_SYNC_INTERVAL_SECONDS * 1_000;
    if (this.lastSyncAt > 0 && Date.now() - this.lastSyncAt < intervalMs) return null;

    this.lastSyncAt = Date.now();
    return this.syncAll();
  }

  async syncAll(): Promise<TokenSyncResult> {
    if (this.syncInFlight) return this.syncInFlight;

    this.syncInFlight = this.runSync().finally(() => {
      this.syncInFlight = null;
    });
    return this.syncInFlight;
  }

  private async runSync(): Promise<TokenSyncResult> {
    const chains = ChainAdapterRegistry.getInstance().tradable();
    let tokens = 0;
    let promoted = 0;
    let stocks = 0;

    for (const descriptor of chains) {
      try {
        // Seed the allowlist first so the rows exist when the sync below
        // refreshes metrics. Seeding after would leave a curated stock without
        // numbers until some later pass happened to find it.
        stocks += await this.syncCuratedStocks(descriptor.chainId);
        tokens += await this.syncChain(descriptor.chainId);
        promoted += await this.promoteIndexedTokens(descriptor.chainId);
      } catch (error) {
        logger.warn("Token discovery sync failed for chain", {
          chainId: descriptor.chainId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info("Token discovery sync complete", { chains: chains.length, tokens, promoted, stocks });
    return { chains: chains.length, tokens, promoted, stocks };
  }

  /**
   * Writes the curated stock allowlist into the catalogue.
   *
   * Identity and asset class only — never metrics. Metrics belong to the sync
   * pass, and inventing them here would put a number on a row that no provider
   * stands behind. The upsert leaves every market column untouched, so a stock
   * whose pool the indexer already prices keeps its numbers across restarts.
   */
  private async syncCuratedStocks(chainId: ChainId): Promise<number> {
    const stocks = stocksForChain(chainId);
    if (stocks.length === 0) return 0;

    const db = DatabaseService.getInstance();
    let written = 0;

    for (const stock of stocks) {
      // EVM addresses are case-insensitive and every other EVM row is stored
      // lowercased (pools come out of logs that way). Solana mints are base58
      // and case-sensitive — lowercasing one corrupts it into a non-existent
      // mint, so only 0x addresses are normalised.
      const contractId = stock.contractId.startsWith("0x")
        ? stock.contractId.toLowerCase()
        : stock.contractId;
      try {
        await db.prisma.token.upsert({
          where: { chainId_contractId: { chainId, contractId } },
          create: {
            chainId,
            contractId,
            symbol: stock.symbol,
            name: stock.name,
            decimals: stock.decimals,
            assetClass: "EQUITY",
          },
          update: {
            symbol: stock.symbol,
            name: stock.name,
            decimals: stock.decimals,
            assetClass: "EQUITY",
          },
        });
        written++;
      } catch (error) {
        logger.warn("Failed to seed curated stock", {
          chainId,
          contractId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return written;
  }

  /**
   * Chainlink reference prices for a chain's curated equities, keyed by
   * lowercased contract id.
   *
   * Read in parallel because they are independent, and cached inside the oracle
   * so a sync that runs every cycle does not hammer the RPC. Only curated
   * instruments with a feed are read — the long tail has no oracle.
   */
  private async equityOraclePrices(chainId: ChainId): Promise<Map<string, number>> {
    const withFeeds = stocksForChain(chainId).filter((s) => s.oracleFeed);
    const prices = new Map<string, number>();

    await Promise.all(
      withFeeds.map(async (stock) => {
        const price = await EquityPriceOracle.getInstance().price(chainId, stock.oracleFeed!);
        if (price && price.priceUsd > 0) prices.set(stock.contractId.toLowerCase(), price.priceUsd);
      })
    );

    return prices;
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
        OR: [
          { liquidityUsd: { gte: MIN_LIQUIDITY_USD } },
          { volume24h: { gt: 0 } },
        ],
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
    const config = ConfigManager.getInstance().config;
    const db = DatabaseService.getInstance();
    const registry = DEXRegistry.getInstance();
    const provider = this.marketData();
    const external = marketDataIsExternal();

    const listed = await registry.getSwappableTokens(false, chainId);
    const listedIds = new Set(listed.map((t) => t.contractId.toLowerCase()));
    const cap = config.MARKET_DATA_MAX_TOKENS_PER_CHAIN_PER_SYNC;

    interface CatalogueToken {
      contractId: string;
      symbol: string;
      name: string;
      decimals: number;
      routable: boolean;
      metricsUpdatedAt: Date | null;
    }

    // Newest catalogue rows first. Ordering by volume pinned the same old
    // high-volume tokens every pass, so a new token either never entered the
    // list or never got refreshed once it did.
    const catalogued = await db.prisma.token.findMany({
      where: { chainId },
      select: {
        contractId: true,
        symbol: true,
        name: true,
        decimals: true,
        metricsUpdatedAt: true,
      },
      orderBy: [
        { pairCreatedAt: { sort: "desc", nulls: "last" } },
        { volume24h: { sort: "desc", nulls: "last" } },
      ],
      take: cap,
    });

    const byId = new Map<string, CatalogueToken>();
    const add = (token: CatalogueToken) => {
      const key = token.contractId.toLowerCase();
      if (!byId.has(key) && byId.size < cap) byId.set(key, token);
    };

    // 1. Newest tokens from the external feed. Without this, switching to
    // GeckoTerminal only repaints rows a DEX list or an old index already
    // knew — the catalogue never grows, and every row looks months old.
    if (external && typeof provider.topTokens === "function") {
      const seeded = await provider.topTokens(chainId, Math.min(60, cap)).catch((error) => {
        logger.warn("External catalogue seed failed; keeping known tokens", {
          chainId,
          provider: provider.name,
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as TokenMarketData[];
      });

      for (const token of seeded) {
        add({
          contractId: token.contractId,
          symbol: token.symbol ?? token.contractId.slice(0, 8),
          name: token.name ?? token.symbol ?? token.contractId,
          decimals: token.decimals ?? 18,
          routable: listedIds.has(token.contractId.toLowerCase()),
          metricsUpdatedAt: null,
        });
      }
    }

    // 2. Tokens this deployment can route.
    for (const token of listed) {
      add({ ...token, routable: true, metricsUpdatedAt: null });
    }

    // 3. Existing catalogue rows, newest first.
    for (const token of catalogued) {
      add({
        ...token,
        routable: listedIds.has(token.contractId.toLowerCase()),
      });
    }

    const tokens = [...byId.values()];
    if (tokens.length === 0) return 0;

    // Curated equities prefer the issuer's Chainlink reference feed: it is the
    // total-return primary-market price, where the AMM price on a thin book can
    // be anything. Read once per sync so a stock shows a real price before the
    // indexer has seen any of its pools. Absent leaves the other sources in charge.
    const oraclePrices = await this.equityOraclePrices(chainId);

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
        return new Map<string, TokenMarketData>();
      });

    const maxAgeMs = config.MARKET_DATA_MAX_METRIC_AGE_SECONDS * 1_000;
    const now = new Date();
    const staleBefore = new Date(now.getTime() - maxAgeMs);
    let synced = 0;

    for (const token of tokens) {
      try {
        const market = metrics.get(token.contractId.toLowerCase());
        const routable = token.routable || listedIds.has(token.contractId.toLowerCase());

        // Fall back to a DEX-derived spot price only when the provider has no
        // price at all. It's a live quote with no history behind it, which is
        // why it can't populate the change/volume columns. Only for routable
        // tokens: quoting one that is in no provider list is a guaranteed
        // round trip to "no route", several hundred times per pass.
        const oraclePrice = oraclePrices.get(token.contractId.toLowerCase());
        const priceUsd =
          oraclePrice ??
          market?.priceUsd ??
          (routable
            ? await registry.getTokenPrice(token.symbol, chainId).catch(() => 0)
            : 0);

        // Identity always refreshes; metrics only overwrite when the provider
        // actually returned one. A null must not clobber a good stored value —
        // that's how a transient upstream blip erases a whole chain's numbers.
        const identity = {
          symbol: market?.symbol ?? token.symbol,
          name: market?.name ?? token.name,
          decimals: market?.decimals ?? token.decimals,
          isRoutable: routable,
          lastSyncedAt: now,
        };

        const confirmed = hasMetrics(market);
        const storedAge = token.metricsUpdatedAt;
        const stale = !storedAge || storedAge < staleBefore;

        let marketFields: Record<string, unknown>;
        if (external && !confirmed && stale) {
          // The provider no longer returns this token (or the pass was cut
          // short) and what is stored is past the freshness horizon. Unknown
          // is the honest answer; a months-old price is not. A live oracle or
          // DEX spot price still counts as a price reading, but it cannot
          // refresh volume or change columns.
          marketFields = {
            ...CLEARED_METRICS,
            ...(priceUsd && priceUsd > 0 ? { priceUsd } : {}),
            metricsUpdatedAt: priceUsd && priceUsd > 0 ? now : null,
          };
        } else {
          marketFields = {
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
            ...(confirmed || (external && priceUsd && priceUsd > 0)
              ? { metricsUpdatedAt: now }
              : {}),
          };
        }

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

    // Rows outside this pass's token cap are not iterated above, so an old
    // high-volume token could keep months-old numbers forever while never
    // being selected. Age them out in one statement — but only when the
    // provider actually answered for this chain, so a rate-limited or failed
    // pass does not blank a page that would have been fine next cycle.
    if (external && metrics.size > 0) {
      await db.prisma.token
        .updateMany({
          where: {
            chainId,
            OR: [
              { metricsUpdatedAt: null },
              { metricsUpdatedAt: { lt: staleBefore } },
            ],
          },
          data: CLEARED_METRICS,
        })
        .catch((error) => {
          logger.warn("Failed to age out stale token metrics", {
            chainId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
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

    if (filters.assetClass) {
      where.assetClass = filters.assetClass;
    }

    // Curated equities bypass the liquidity floor. They are verified listings,
    // not the long tail the floor exists to keep out, and a stock's AMM depth
    // can be thin without the asset being untrustworthy. Applying it would
    // empty the Stocks tab of exactly the names it is meant to show.
    if (!filters.includeIlliquid && filters.assetClass !== "EQUITY") {
      where.OR = [
        { liquidityUsd: null },
        { liquidityUsd: { gte: MIN_LIQUIDITY_USD } },
        { volume24h: { gt: 0 } },
      ];
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
        const spotPrice = await registry.getTokenPrice(match.symbol, chainId).catch(() => null);
        token = await db.prisma.token.upsert({
          where: { chainId_contractId: { chainId, contractId: match.contractId } },
          create: {
            chainId,
            contractId: match.contractId,
            symbol: match.symbol,
            name: match.name,
            decimals: match.decimals,
            priceUsd: spotPrice !== null && spotPrice > 0 ? spotPrice : null,
          },
          update: {
            priceUsd: spotPrice !== null && spotPrice > 0 ? spotPrice : undefined,
          },
        });
      }
    }

    return token;
  }
}

