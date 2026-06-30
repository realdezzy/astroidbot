import { PriceHistoryService } from "../priceHistory.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "../../types/strategy.js";

export class MomentumStrategy implements Strategy {
  async execute(ctx: StrategyContext, _state: StrategyState): Promise<RebalanceAction[]> {
    const { config, settings, tokens, balances } = ctx;
    const lookback = (config.lookbackPeriods as number) ?? 20;
    const threshold = (config.momentumThresholdPct as number) ?? 2;
    const positionSize = (config.positionSizeUsd as number) ?? 10;
    const tokenUniverse = ((config.tokenUniverse as string) ?? "")
      .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    const exitThreshold = (config.exitThresholdPct as number) ?? -1;
    void settings;

    const ph = PriceHistoryService.getInstance();
    const available = tokenUniverse.length > 0
      ? tokens.filter(t => tokenUniverse.includes(t.symbol.toUpperCase()))
      : tokens.slice(0, 10);

    const actions: RebalanceAction[] = [];

    for (const token of available) {
      const momentum = await ph.computeMomentum(token.symbol, lookback);

      // Fix: detect open position via actual wallet balance, not a stale DB trade record.
      // A user who manually sold the token will have a near-zero balance.
      const bal = balances.find(b => b.symbol.toUpperCase() === token.symbol.toUpperCase());
      const hasPosition = bal !== undefined && bal.balance > 0.0001;

      if (momentum > threshold && !hasPosition) {
        actions.push({
          tokenIn: "STX", tokenOut: token.symbol, amountIn: positionSize, direction: "BUY",
          reason: `Momentum: ${token.symbol} +${momentum.toFixed(1)}%`,
        });
      } else if (momentum < exitThreshold && hasPosition) {
        actions.push({
          tokenIn: token.symbol, tokenOut: "STX",
          amountIn: Math.min(positionSize, bal!.balance),
          direction: "SELL",
          reason: `Momentum exit: ${token.symbol} ${momentum.toFixed(1)}%`,
        });
      }
    }

    return actions;
  }
}
