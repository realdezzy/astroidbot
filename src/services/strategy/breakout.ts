import { DatabaseService } from "../db.js";
import { PriceHistoryService } from "../priceHistory.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "../../types/strategy.js";

export class BreakoutStrategy implements Strategy {
  async execute(ctx: StrategyContext, state: StrategyState): Promise<RebalanceAction[]> {
    const { userId, walletId, config, settings } = ctx;
    const lookback = (config.lookbackPeriods as number) ?? 20;
    const breakoutPct = (config.breakoutPct as number) ?? 3;
    const tokenPair = ((config.tokenPair as string) ?? "STX/sUSDT").split("/");
    const tokenIn = tokenPair[0] ?? "STX";
    const tokenOut = tokenPair[1] ?? "sUSDT";
    const positionSize = (config.positionSizeUsd as number) ?? 10;
    void settings;

    const ph = PriceHistoryService.getInstance();
    const prices = await ph.getHistory(tokenOut, 1);
    if (prices.length === 0) return [];
    const currentPrice = prices[0]!;

    const high = await ph.computeHigh(tokenOut, lookback);
    const low = await ph.computeLow(tokenOut, lookback);
    if (high === 0 || low === 0) return [];

    const isAboveHigh = currentPrice > high * (1 + breakoutPct / 100);
    const isBelowLow = currentPrice < low * (1 - breakoutPct / 100);

    // Fix: only trigger on the crossover cycle (was below high last cycle, now above).
    // This prevents repeated entries while price stays above the high.
    const wasAboveHigh = state.wasAboveHigh ?? false;
    const wasAboveLow = state.wasAboveLow ?? false;

    state.wasAboveHigh = isAboveHigh;
    state.wasAboveLow = isBelowLow;

    const db = DatabaseService.getInstance();
    const actions: RebalanceAction[] = [];

    if (isAboveHigh && !wasAboveHigh) {
      const existing = await db.prisma.trade.findFirst({
        where: { userId, walletId, tokenOut, status: "CONFIRMED", direction: "BUY" },
      });
      if (!existing) {
        actions.push({
          tokenIn, tokenOut, amountIn: positionSize, direction: "BUY",
          reason: `Breakout: ${tokenOut} crossed above ${lookback}-period high`,
        });
      }
    }

    if (isBelowLow && !wasAboveLow) {
      const existing = await db.prisma.trade.findFirst({
        where: { userId, walletId, tokenOut, status: "CONFIRMED", direction: "BUY" },
      });
      if (existing) {
        actions.push({
          tokenIn: tokenOut, tokenOut: tokenIn,
          amountIn: Math.min(positionSize, existing.amountIn),
          direction: "SELL",
          reason: `Breakdown: ${tokenOut} crossed below ${lookback}-period low`,
        });
      }
    }

    return actions;
  }
}
