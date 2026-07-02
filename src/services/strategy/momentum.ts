import { PriceHistoryService } from "../priceHistory.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "../../types/strategy.js";

export class MomentumStrategy implements Strategy {
  async execute(ctx: StrategyContext, _state: StrategyState): Promise<RebalanceAction[]> {
    const { config, settings, tokens, balances } = ctx;
    const lookback = (config.lookbackPeriods as number) ?? 50; // Increased default to 50
    const threshold = (config.momentumThresholdPct as number) ?? 2;
    const positionSize = (config.positionSizeUsd as number) ?? 10;
    const tokenUniverse = ((config.tokenUniverse as string) ?? "")
      .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    const exitThreshold = (config.exitThresholdPct as number) ?? -1;
    const maxPositions = (config.maxPositions as number) ?? 3;
    const slippageBps = (config.slippageBps as number) ?? settings.slippageBps;

    const ph = PriceHistoryService.getInstance();
    const available = tokenUniverse.length > 0
      ? tokens.filter(t => tokenUniverse.includes(t.symbol.toUpperCase()))
      : tokens.slice(0, 10);

    const actions: RebalanceAction[] = [];
    const signals: Array<{ symbol: string; momentum: number; balance: number; hasPosition: boolean }> = [];

    // First, compute momentum score and check existing positions for all available tokens
    for (const token of available) {
      const momentum = await ph.computeMomentum(token.symbol, lookback);
      const bal = balances.find(b => b.symbol.toUpperCase() === token.symbol.toUpperCase());
      const hasPosition = bal !== undefined && bal.balance > 0.0001;
      signals.push({
        symbol: token.symbol,
        momentum,
        balance: bal?.balance ?? 0,
        hasPosition,
      });
    }

    // Identify exits first to free up slots
    const activeBeforeBuys = signals.filter(s => s.hasPosition);
    let currentPositionCount = activeBeforeBuys.length;

    for (const sig of activeBeforeBuys) {
      if (sig.momentum < exitThreshold) {
        actions.push({
          tokenIn: sig.symbol,
          tokenOut: "STX",
          amountIn: sig.balance,
          direction: "SELL",
          slippageBps,
          reason: `Momentum exit: ${sig.symbol} ${sig.momentum.toFixed(1)}%`,
        });
        currentPositionCount--;
      }
    }

    // Sort potential buy candidates by momentum descending
    const buyCandidates = signals
      .filter(s => !s.hasPosition && s.momentum > threshold)
      .sort((a, b) => b.momentum - a.momentum);

    for (const candidate of buyCandidates) {
      if (currentPositionCount >= maxPositions) {
        break; // Reached portfolio slot limit
      }
      actions.push({
        tokenIn: "STX",
        tokenOut: candidate.symbol,
        amountIn: positionSize,
        direction: "BUY",
        slippageBps,
        reason: `Momentum: ${candidate.symbol} +${candidate.momentum.toFixed(1)}%`,
      });
      currentPositionCount++;
    }

    return actions;
  }
}
