import { DatabaseService } from "../db.js";
import { PriceHistoryService } from "../priceHistory.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "../../types/strategy.js";

export class RotationalStrategy implements Strategy {
  async execute(ctx: StrategyContext, _state: StrategyState): Promise<RebalanceAction[]> {
    const { userId, walletId, config, settings, tokens } = ctx;
    const topK = (config.topK as number) ?? 3;
    const rebalanceHours = (config.rebalancePeriodHours as number) ?? 24;
    const positionSize = (config.positionSizeUsd as number) ?? 10;
    const tokenUniverse = ((config.tokenUniverse as string) ?? "")
      .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    void settings;

    const db = DatabaseService.getInstance();
    const lastRebalance = await db.prisma.trade.findFirst({
      where: { userId, walletId, status: "CONFIRMED", direction: "BUY" },
      orderBy: { createdAt: "desc" },
    });
    if (lastRebalance) {
      const elapsed = (Date.now() - lastRebalance.createdAt.getTime()) / 3600000;
      if (elapsed < rebalanceHours) return [];
    }

    const universe = tokenUniverse.length > 0
      ? tokens.filter(t => tokenUniverse.includes(t.symbol.toUpperCase()))
      : tokens.slice(0, 15);

    const ph = PriceHistoryService.getInstance();
    const scored: Array<{ symbol: string; momentum: number }> = [];

    for (const t of universe) {
      const momentum = await ph.computeMomentum(t.symbol, 20);
      scored.push({ symbol: t.symbol, momentum });
    }

    scored.sort((a, b) => b.momentum - a.momentum);
    const top = scored.slice(0, topK);
    const toSell = scored.slice(topK);
    const actions: RebalanceAction[] = [];

    for (const item of toSell) {
      const existing = await db.prisma.trade.findFirst({
        where: { userId, walletId, tokenOut: item.symbol, status: "CONFIRMED", direction: "BUY" },
      });
      if (existing) {
        actions.push({
          tokenIn: item.symbol, tokenOut: "STX",
          amountIn: Math.min(positionSize, existing.amountIn),
          direction: "SELL", reason: `Rotational sell: ${item.symbol}`,
        });
      }
    }

    for (const item of top) {
      const existing = await db.prisma.trade.findFirst({
        where: { userId, walletId, tokenOut: item.symbol, status: "CONFIRMED", direction: "BUY" },
      });
      if (!existing) {
        actions.push({
          tokenIn: "STX", tokenOut: item.symbol, amountIn: positionSize,
          direction: "BUY", reason: `Rotational buy: ${item.symbol} #${scored.indexOf(item) + 1}`,
        });
      }
    }

    return actions;
  }
}
