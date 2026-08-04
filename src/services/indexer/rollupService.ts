import { Prisma } from "@prisma/client";
import { DatabaseService } from "../db.js";
import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";
import type { ChainId } from "../../types/chain.js";

/**
 * Per-pool window aggregates, as Postgres computes them.
 *
 * Prices are carried as the pool's own token0/token1 ratio; converting to USD
 * happens in TS where the anchor prices live.
 */
interface PoolWindowRow {
  poolId: number;
  chainId: string;
  dexId: string;
  baseToken: string;
  pairCreatedAt: Date | null;
  liquidityUsd: number | null;
  close: number | null;
  open5m: number | null;
  open1h: number | null;
  open6h: number | null;
  open24h: number | null;
  vol24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
}

/**
 * Turns candles into the numbers the discovery table renders.
 *
 * The whole rollup is one SQL statement per chain plus one write pass. The
 * obvious alternative — loop tokens, query candles per token — is what makes
 * discovery pages slow: it is thousands of round trips to compute a page of
 * twenty rows, and it gets worse exactly as the product gets more successful.
 *
 * Percentage changes come from candle `open`/`close` rather than from stored
 * price snapshots, so a window's change is always measured against a price
 * that actually traded in that window.
 */
export class RollupService {
  private static instance: RollupService;

  static getInstance(): RollupService {
    if (!RollupService.instance) RollupService.instance = new RollupService();
    return RollupService.instance;
  }

  async rollupAll(chainIds: ChainId[]): Promise<number> {
    let updated = 0;
    for (const chainId of chainIds) {
      try {
        updated += await this.rollupChain(chainId);
      } catch (error) {
        logger.warn("[rollup] failed for chain", {
          chainId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return updated;
  }

  async rollupChain(chainId: ChainId): Promise<number> {
    const db = DatabaseService.getInstance();

    // `FILTER` restricts each aggregate to its own window in a single scan;
    // the array_agg trick pulls the earliest bucket's open per window, which
    // is the denominator every percentage change needs.
    const rows = await db.prisma.$queryRaw<PoolWindowRow[]>(Prisma.sql`
      SELECT
        p."id"            AS "poolId",
        p."chainId"       AS "chainId",
        p."dexId"         AS "dexId",
        p."baseToken"     AS "baseToken",
        p."pairCreatedAt" AS "pairCreatedAt",
        p."liquidityUsd"  AS "liquidityUsd",

        (array_agg(c."close" ORDER BY c."bucketStart" DESC))[1] AS "close",

        (array_agg(c."open" ORDER BY c."bucketStart" ASC)
           FILTER (WHERE c."bucketStart" >= NOW() - INTERVAL '5 minutes'))[1]  AS "open5m",
        (array_agg(c."open" ORDER BY c."bucketStart" ASC)
           FILTER (WHERE c."bucketStart" >= NOW() - INTERVAL '1 hour'))[1]     AS "open1h",
        (array_agg(c."open" ORDER BY c."bucketStart" ASC)
           FILTER (WHERE c."bucketStart" >= NOW() - INTERVAL '6 hours'))[1]    AS "open6h",
        (array_agg(c."open" ORDER BY c."bucketStart" ASC)
           FILTER (WHERE c."bucketStart" >= NOW() - INTERVAL '24 hours'))[1]   AS "open24h",

        COALESCE(SUM(c."volumeUsd")
          FILTER (WHERE c."bucketStart" >= NOW() - INTERVAL '24 hours'), 0)    AS "vol24h",
        COALESCE(SUM(c."buys")
          FILTER (WHERE c."bucketStart" >= NOW() - INTERVAL '24 hours'), 0)    AS "buys24h",
        COALESCE(SUM(c."sells")
          FILTER (WHERE c."bucketStart" >= NOW() - INTERVAL '24 hours'), 0)    AS "sells24h"

      FROM "IndexedPool" p
      LEFT JOIN "PoolCandle" c
        ON c."poolId" = p."id"
       AND c."bucketStart" >= NOW() - INTERVAL '24 hours'
      WHERE p."chainId" = ${chainId}
        AND p."baseToken" IS NOT NULL
      GROUP BY p."id"
    `);

    if (rows.length === 0) return 0;

    const tokenMetrics = this.foldPoolsIntoTokens(rows);
    return this.writeTokens(chainId, tokenMetrics);
  }

  /**
   * Collapses per-pool rows into per-token metrics.
   *
   * A token can trade in several pools (different fee tiers, different quote
   * assets). Volume and transaction counts sum across all of them; price and
   * the percentage changes come from the single deepest pool rather than an
   * average, because averaging a deep pool with a dust pool moves the quoted
   * price toward a price nobody can actually trade at.
   */
  private foldPoolsIntoTokens(rows: PoolWindowRow[]): Map<string, TokenRollup> {
    const byToken = new Map<string, TokenRollup>();

    for (const row of rows) {
      // Exactly one token per pool: the base. The quote side is a stable or the
      // wrapped native, whose price is set by the anchor, not by whatever it
      // happens to be paired against.
      const contractId = row.baseToken;
      const depth = row.liquidityUsd ?? 0;

      const existing = byToken.get(contractId);
      const entry: TokenRollup = existing ?? {
        contractId,
        dexId: row.dexId,
        volume24h: 0,
        buys24h: 0,
        sells24h: 0,
        liquidityUsd: 0,
        bestDepth: -1,
        priceUsd: null,
        change5m: null,
        change1h: null,
        change6h: null,
        change24h: null,
        pairCreatedAt: row.pairCreatedAt,
      };

      entry.volume24h += Number(row.vol24h ?? 0);
      entry.buys24h += Number(row.buys24h ?? 0);
      entry.sells24h += Number(row.sells24h ?? 0);
      entry.liquidityUsd += depth;

      // Earliest pair creation is the token's age, matching how the column
      // reads: "how long has this been tradeable", not "…in this pool".
      if (
        row.pairCreatedAt &&
        (!entry.pairCreatedAt || row.pairCreatedAt < entry.pairCreatedAt)
      ) {
        entry.pairCreatedAt = row.pairCreatedAt;
      }

      if (depth > entry.bestDepth) {
        entry.bestDepth = depth;
        entry.dexId = row.dexId;

        // Candles already hold the base token's price *in USD* — ingestion
        // multiplies by the quote asset's dollar price at decode time — so
        // these need no further conversion.
        entry.priceUsd = positive(row.close);
        entry.change5m = this.pctChange(positive(row.open5m), entry.priceUsd);
        entry.change1h = this.pctChange(positive(row.open1h), entry.priceUsd);
        entry.change6h = this.pctChange(positive(row.open6h), entry.priceUsd);
        entry.change24h = this.pctChange(positive(row.open24h), entry.priceUsd);
      }

      byToken.set(contractId, entry);
    }

    return byToken;
  }

  private pctChange(from: number | null, to: number | null): number | null {
    if (from == null || to == null || from <= 0) return null;
    const pct = ((to - from) / from) * 100;
    return Number.isFinite(pct) ? pct : null;
  }

  /**
   * Writes metrics onto `IndexedToken` — the indexer's own table, never the
   * backend's `Token` catalogue.
   *
   * Only rows `catalogueToken` has already created are touched, and it is not
   * an upsert. A rollup knows a contract address and some numbers; it has no
   * symbol, name or decimals, so creating a row here would produce one that
   * can never render. Pool discovery is what establishes identity, and it
   * always runs before the candles that describe the same pool exist.
   */
  private async writeTokens(
    chainId: ChainId,
    metrics: Map<string, TokenRollup>
  ): Promise<number> {
    const db = DatabaseService.getInstance();
    const minLiquidity = ConfigManager.getInstance().config.INDEXER_MIN_POOL_LIQUIDITY_USD;

    const known = await db.prisma.indexedToken.findMany({
      where: { chainId, contractId: { in: [...metrics.keys()] } },
      select: { id: true, contractId: true, priceUsd: true },
    });

    if (known.length === 0) return 0;

    const updates = known.flatMap((token) => {
      const m = metrics.get(token.contractId);
      if (!m) return [];

      // A pool below the floor is noise — its "price" is whatever the last
      // trader decided. Activity still counts; the quote doesn't.
      const trustPrice = m.liquidityUsd >= minLiquidity;

      // Trades we saw but couldn't value — the chain has no USD anchor — are
      // reported as unknown volume, not zero. Zero would claim the token
      // didn't trade, when in fact it traded and we couldn't price it, and the
      // two sort to opposite ends of a volume-ranked table.
      const sawTrades = m.buys24h + m.sells24h > 0;
      const volume24h = m.volume24h === 0 && sawTrades ? null : m.volume24h;

      return [
        db.prisma.indexedToken.update({
          where: { id: token.id },
          data: {
            dexId: m.dexId,
            // Only overwrite a stored price with one we actually have. Writing
            // null here on a quiet tick would blank the price column for every
            // token that simply hasn't traded recently.
            ...(trustPrice && m.priceUsd != null ? { priceUsd: m.priceUsd } : {}),
            volume24h,
            txnsBuys24h: m.buys24h,
            txnsSells24h: m.sells24h,
            liquidityUsd: m.liquidityUsd > 0 ? m.liquidityUsd : null,
            ...(trustPrice
              ? {
                  priceChange5m: m.change5m,
                  priceChange1h: m.change1h,
                  priceChange6h: m.change6h,
                  priceChange24h: m.change24h,
                }
              : {}),
            ...(m.pairCreatedAt ? { pairCreatedAt: m.pairCreatedAt } : {}),
            lastRolledUpAt: new Date(),
          },
        }),
      ];
    });

    if (updates.length === 0) return 0;

    await db.prisma.$transaction(updates);
    return updates.length;
  }

  /**
   * Drops candles past the retention horizon.
   *
   * Without this the table grows without bound for data no window ever reads.
   * Called from the cycle rather than a cron for the same reason as everything
   * else here — one scheduler.
   */
  async pruneOldCandles(): Promise<number> {
    const db = DatabaseService.getInstance();
    const days = ConfigManager.getInstance().config.INDEXER_CANDLE_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - days * 86_400_000);

    const { count } = await db.prisma.poolCandle.deleteMany({
      where: { bucketStart: { lt: cutoff } },
    });

    if (count > 0) logger.info("[rollup] pruned old candles", { count, days });
    return count;
  }
}

/**
 * A usable price, or null.
 *
 * Zero, NaN and negatives all mean "we couldn't price this" rather than a real
 * quote, and letting any of them through makes the percentage change either
 * -100% or NaN — both of which render as confident nonsense.
 */
function positive(value: number | null): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

interface TokenRollup {
  contractId: string;
  dexId: string;
  volume24h: number;
  buys24h: number;
  sells24h: number;
  liquidityUsd: number;
  /** Liquidity of the deepest pool seen so far — decides which pool sets price. */
  bestDepth: number;
  priceUsd: number | null;
  change5m: number | null;
  change1h: number | null;
  change6h: number | null;
  change24h: number | null;
  pairCreatedAt: Date | null;
}
