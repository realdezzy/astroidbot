import { DatabaseService } from "../db.js";
import { PriceHistoryService } from "../priceHistory.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "../../types/strategy.js";

export class BreakoutStrategy implements Strategy {
  async execute(ctx: StrategyContext, state: StrategyState): Promise<RebalanceAction[]> {
    const { config, settings, balances } = ctx;
    const lookback = (config.lookbackPeriods as number) ?? 50; // Increased default to 50
    const breakoutPct = (config.breakoutPct as number) ?? 3;
    const tokenPair = ((config.tokenPair as string) ?? "STX/sUSDT").split("/");
    const tokenIn = tokenPair[0] ?? "STX";
    const tokenOut = tokenPair[1] ?? "sUSDT";
    const positionSize = (config.positionSizeUsd as number) ?? 10;
    const slippageBps = (config.slippageBps as number) ?? settings.slippageBps;

    const ph = PriceHistoryService.getInstance();
    const prices = await ph.getHistory(tokenOut, 1);
    if (prices.length === 0) return [];
    const currentPrice = prices[0]!;

    const high = await ph.computeHigh(tokenOut, lookback);
    const low = await ph.computeLow(tokenOut, lookback);
    if (high === 0 || low === 0) return [];

    const isAboveHigh = currentPrice > high * (1 + breakoutPct / 100);
    const isBelowLow = currentPrice < low * (1 - breakoutPct / 100);

    const wasAboveHigh = state.wasAboveHigh ?? false;
    const wasAboveLow = state.wasAboveLow ?? false;

    state.wasAboveHigh = isAboveHigh;
    state.wasAboveLow = isBelowLow;

    const bal = balances.find(b => b.symbol.toUpperCase() === tokenOut.toUpperCase());
    const hasPosition = bal !== undefined && bal.balance > 0.0001;

    const actions: RebalanceAction[] = [];

    if (isAboveHigh && !wasAboveHigh) {
      if (!hasPosition) {
        actions.push({
          tokenIn,
          tokenOut,
          amountIn: positionSize,
          direction: "BUY",
          slippageBps,
          reason: `Breakout: ${tokenOut} crossed above ${lookback}-period high`,
        });
      }
    }

    if (isBelowLow && !wasAboveLow) {
      if (hasPosition) {
        actions.push({
          tokenIn: tokenOut,
          tokenOut: tokenIn,
          amountIn: bal!.balance, // Exit the full position on breakdown
          direction: "SELL",
          slippageBps,
          reason: `Breakdown: ${tokenOut} crossed below ${lookback}-period low`,
        });
      }
    }

    return actions;
  }
}
