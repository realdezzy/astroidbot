import { DatabaseService } from "../db.js";
import { PriceHistoryService } from "../priceHistory.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "../../types/strategy.js";

export class RotationalStrategy implements Strategy {
  async execute(ctx: StrategyContext, state: StrategyState): Promise<RebalanceAction[]> {
    const { config, settings, tokens, balances } = ctx;
    const topK = (config.topK as number) ?? 3;
    const rebalanceHours = (config.rebalancePeriodHours as number) ?? 24;
    const positionSize = (config.positionSizeUsd as number) ?? 10;
    const tokenUniverse = ((config.tokenUniverse as string) ?? "")
      .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    const slippageBps = (config.slippageBps as number) ?? settings.slippageBps;

    // Fix: use state-based last rotational execution time instead of querying generic trades table
    const lastRebalanceTime = state.lastRebalanceTime as number | undefined;
    if (lastRebalanceTime) {
      const elapsed = (Date.now() - lastRebalanceTime) / 3600000;
      if (elapsed < rebalanceHours) return [];
    }

    const universe = tokenUniverse.length > 0
      ? tokens.filter(t => tokenUniverse.includes(t.symbol.toUpperCase()))
      : tokens.slice(0, 15);

    const ph = PriceHistoryService.getInstance();
    const scored: Array<{ symbol: string; momentum: number }> = [];

    for (const t of universe) {
      const momentum = await ph.computeMomentum(t.symbol, 50); // Increased periods to 50
      scored.push({ symbol: t.symbol, momentum });
    }

    scored.sort((a, b) => b.momentum - a.momentum);
    const top = scored.slice(0, topK);
    const toSell = scored.slice(topK);
    const actions: RebalanceAction[] = [];

    // Identify positions to exit based on live balances
    for (const item of toSell) {
      const bal = balances.find(b => b.symbol.toUpperCase() === item.symbol.toUpperCase());
      if (bal && bal.balance > 0.0001) {
        actions.push({
          tokenIn: item.symbol,
          tokenOut: "STX",
          amountIn: bal.balance, // Sell the entire position
          direction: "SELL",
          slippageBps,
          reason: `Rotational sell: ${item.symbol}`,
        });
      }
    }

    // Identify new positions to buy
    for (const item of top) {
      const bal = balances.find(b => b.symbol.toUpperCase() === item.symbol.toUpperCase());
      const hasPosition = bal !== undefined && bal.balance > 0.0001;
      if (!hasPosition) {
        actions.push({
          tokenIn: "STX",
          tokenOut: item.symbol,
          amountIn: positionSize,
          direction: "BUY",
          slippageBps,
          reason: `Rotational buy: ${item.symbol} #${scored.indexOf(item) + 1}`,
        });
      }
    }

    if (actions.length > 0) {
      state.lastRebalanceTime = Date.now();
    }

    return actions;
  }
}
