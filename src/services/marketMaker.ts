import { logger } from "../utils/logger.js";
import { AIOrchestrator } from "./ai.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { DatabaseService } from "./db.js";
import { PriceHistoryService } from "./priceHistory.js";
import { resolveTradeSettings } from "./tradeSettings.js";
import type { RebalanceAction, TokenBalance } from "../types.js";

export class MarketMakerService {
  private static instance: MarketMakerService;
  private lastMidPrices: Map<string, number> = new Map();

  private constructor() {}

  static getInstance(): MarketMakerService {
    if (!MarketMakerService.instance) {
      MarketMakerService.instance = new MarketMakerService();
    }
    return MarketMakerService.instance;
  }

  async tick(
    userId: number,
    walletId: number,
    balances: TokenBalance[],
    chainId?: string
  ): Promise<RebalanceAction[]> {
    const db = DatabaseService.getInstance();
    const registry = DEXRegistry.getInstance();
    const ai = AIOrchestrator.getInstance();
    const actions: RebalanceAction[] = [];

    const totalPortfolioValue = balances.reduce((sum, b) => sum + b.usdValue, 0);

    const settings = await resolveTradeSettings(userId, "personal", chainId);
    const maxPositionPct = settings.maxPositionPct;
    const slippageBps = settings.slippageBps;
    const maxGridPositionValue = totalPortfolioValue * (maxPositionPct / 100);
    const baseGridSize = maxGridPositionValue / 20;

    const grids = await db.findGridsByWallet(walletId);

    if (grids.length === 0) {
      const pairs = registry.getTradingPairs();

      if (pairs.length > 0) {
        const pair = pairs[0]!;
        try {
          const gridConfig = await ai.generateGridSpreads(
            userId,
            `${pair.tokenX} / ${pair.tokenY}`,
            0.02,
            1.5
          );

          await db.upsertGrid({
            userId,
            walletId,
            tokenPair: `${pair.tokenX} / ${pair.tokenY}`,
            midPrice: gridConfig.midPrice,
            gridLevels: gridConfig.levels,
            spreadBps: gridConfig.spreadBps,
          });

          this.lastMidPrices.set(
            `${pair.tokenX} / ${pair.tokenY}`,
            gridConfig.midPrice
          );
        } catch (err) {
          logger.warn("Failed to generate initial grid configuration", { error: err });
        }
      }

      return actions;
    }

    for (const grid of grids) {
      const [tokenA, tokenB] = grid.tokenPair.split("/").map((s) => s.trim());
      if (!tokenA || !tokenB) continue;

      const route = await registry.getBestQuote(tokenA, tokenB, 0.001).catch(() => null);

      if (!route) {
        logger.warn("No swap route found for grid pair", {
          pair: grid.tokenPair,
        });
        continue;
      }

      const priceA = await registry.getTokenPrice(tokenA);
      const priceB = await registry.getTokenPrice(tokenB);

      // Falling back to a mid price of 1.0 placed a full grid of real orders
      // around a number that was never a price of anything. The last known mid
      // is a real observation and is still worth using; in its absence there is
      // nothing to quote around, so the pair is skipped this cycle.
      const lastKnownMid = this.lastMidPrices.get(grid.tokenPair);
      const currentMidPrice =
        priceA && priceB ? priceA / priceB : lastKnownMid;

      if (currentMidPrice === undefined) {
        logger.info("[marketMaker] pair cannot be priced and has no last mid; skipping", {
          tokenPair: grid.tokenPair,
        });
        continue;
      }

      let config = {
        midPrice: grid.midPrice,
        levels: grid.gridLevels,
        spreadBps: grid.spreadBps,
      };

      // Caching: only call AI to refresh grid config if older than 30 minutes
      const ageMs = Date.now() - new Date(grid.lastUpdated).getTime();
      if (ageMs > 30 * 60 * 1000) {
        const volatility = await this.computeVolatility(tokenA, tokenB);
        // Asking the model to size spreads from a volatility we invented is
        // worse than not re-sizing them. The grid keeps the configuration it
        // already has until there is history to justify changing it — the
        // same outcome as the catch below, reached deliberately.
        if (volatility === null) {
          logger.info("[marketMaker] no volatility history; keeping cached grid configuration", {
            tokenPair: grid.tokenPair,
          });
        } else {
          try {
            const aiConfig = await ai.generateGridSpreads(
              userId,
              grid.tokenPair,
              volatility,
              currentMidPrice
            );

            await db.upsertGrid({
              userId,
              walletId,
              tokenPair: grid.tokenPair,
              midPrice: aiConfig.midPrice,
              gridLevels: aiConfig.levels,
              spreadBps: aiConfig.spreadBps,
            });

            config = {
              midPrice: aiConfig.midPrice,
              levels: aiConfig.levels,
              spreadBps: aiConfig.spreadBps,
            };
          } catch (err) {
            logger.warn("Failed to refresh grid configuration from AI, falling back to cached configuration", { error: err });
          }
        }
      }

      const spreadBpsDecimal = config.spreadBps / 10000;

      for (let level = 1; level <= config.levels; level++) {
        const levelSpread = spreadBpsDecimal * level;
        const buyPrice = config.midPrice * (1 - levelSpread);
        const sellPrice = config.midPrice * (1 + levelSpread);

        const priceDeviation = Math.abs(
          (currentMidPrice - config.midPrice) / config.midPrice
        );

        if (priceDeviation > spreadBpsDecimal * level) {
          const tradeAmount = baseGridSize * level;
          const direction =
            currentMidPrice > config.midPrice ? "SELL" : "BUY";

          actions.push({
            tokenIn: direction === "BUY" ? tokenA : tokenB,
            tokenOut: direction === "BUY" ? tokenB : tokenA,
            amountIn: tradeAmount,
            direction,
            slippageBps,
            reason: `Grid level ${level}: price ${currentMidPrice.toFixed(4)} deviated beyond ${levelSpread * 100}% band (buy: ${buyPrice.toFixed(4)}, sell: ${sellPrice.toFixed(4)})`,
          });
        }
      }

      this.lastMidPrices.set(grid.tokenPair, currentMidPrice);
      logger.debug("Market maker tick complete", {
        pair: grid.tokenPair,
        midPrice: currentMidPrice,
        levels: config.levels,
        spreadBps: config.spreadBps,
        actions: actions.length,
      });
    }

    return actions;
  }

  /**
   * Realised volatility of the pair, or null when neither leg has history.
   *
   * Both legs used to fall back to a flat 0.02 on any failure, so a pair with
   * no recorded prices at all produced a confident "2% volatility" that the
   * model then sized real grid spreads from. One leg is enough to form a view;
   * neither is not.
   */
  private async computeVolatility(
    tokenA: string,
    tokenB: string
  ): Promise<number | null> {
    const ph = PriceHistoryService.getInstance();
    const volA = await ph.computeVolatility(tokenA, 30).catch(() => null);
    const volB = await ph.computeVolatility(tokenB, 30).catch(() => null);

    const known = [volA, volB].filter((v): v is number => v !== null);
    if (known.length === 0) return null;

    // The floor stays: a measured near-zero volatility still needs a spread
    // wide enough to cover fees, which is a property of trading rather than of
    // the measurement.
    return Math.min(0.5, Math.max(...known, 0.02));
  }
}
