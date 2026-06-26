import { logger } from "../utils/logger.js";
import { AIOrchestrator } from "./ai.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { DatabaseService } from "./db.js";
import type { GridSpreadConfig, RebalanceAction, TokenBalance } from "../types.js";

export class MarketMakerService {
  private static instance: MarketMakerService;
  private lastMidPrices: Map<string, number> = new Map();

  private constructor() {
  }

  static getInstance(): MarketMakerService {
    if (!MarketMakerService.instance) {
      MarketMakerService.instance = new MarketMakerService();
    }
    return MarketMakerService.instance;
  }

  async tick(
    userId: number,
    walletId: number,
    balances: TokenBalance[]
  ): Promise<RebalanceAction[]> {
    const db = DatabaseService.getInstance();
    const registry = DEXRegistry.getInstance();
    const ai = AIOrchestrator.getInstance();
    const actions: RebalanceAction[] = [];

    const totalPortfolioValue = balances.reduce((sum, b) => sum + b.usdValue, 0);

    const settings = await db.findTradeSettings(userId, "personal");
    const maxPositionPct = settings?.maxPositionPct ?? 25;
    const maxGridPositionValue = totalPortfolioValue * (maxPositionPct / 100);
    const baseGridSize = maxGridPositionValue / 20;

    const grids = await db.findGridsByWallet(walletId);

    if (grids.length === 0) {
      const pairs = registry.getTradingPairs();

      if (pairs.length > 0) {
        const pair = pairs[0]!;
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
      const currentMidPrice =
        priceA > 0 && priceB > 0
          ? priceA / priceB
          : (this.lastMidPrices.get(grid.tokenPair) ?? 1.0);
      const volatility = this.computeVolatility(
        grid.tokenPair,
        currentMidPrice
      );

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

      const config = aiConfig;
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

  private computeVolatility(
    tokenPair: string,
    currentPrice: number
  ): number {
    const lastPrice = this.lastMidPrices.get(tokenPair);
    if (!lastPrice) return 0.02;

    const change = Math.abs((currentPrice - lastPrice) / lastPrice);

    return Math.min(0.5, Math.max(0.005, change * 10));
  }
}
