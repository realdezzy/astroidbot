import { DatabaseService } from "../db.js";
import { PriceHistoryService } from "../priceHistory.js";
import { DEXRegistry } from "../dex/dexRegistry.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "../../types/strategy.js";

export class StopLossTpStrategy implements Strategy {
  async execute(ctx: StrategyContext, _state: StrategyState): Promise<RebalanceAction[]> {
    const { userId, walletId, config, settings, balances } = ctx;
    const token = ((config.token as string) ?? "").toUpperCase();
    const tpPct = (config.takeProfitPct as number) ?? 10;
    const slPct = (config.stopLossPct as number) ?? 5;
    const trailingSl = (config.trailingStopPct as number) ?? 0;
    const trailingLookback = (config.trailingLookbackPeriods as number) ?? 50;
    const slippageBps = (config.slippageBps as number) ?? settings.slippageBps;

    if (!token) return [];

    const balance = balances.find(b => b.symbol.toUpperCase() === token);
    if (!balance || balance.balance <= 0) return [];

    const registry = DEXRegistry.getInstance();
    let currentPrice = await registry.getTokenPrice(token).catch(() => 0);
    if (currentPrice <= 0) {
      currentPrice = balance.usdValue / balance.balance;
    }

    const db = DatabaseService.getInstance();

    const buyTrades = await db.prisma.trade.findMany({
      where: { userId, walletId, tokenOut: token, status: "CONFIRMED", direction: "BUY" },
    });
    if (buyTrades.length === 0) return [];

    const totalCostSTX = buyTrades.reduce((s, t) => s + t.amountIn, 0);
    const totalTokenBought = buyTrades.reduce((s, t) => s + t.amountOut, 0);
    if (totalTokenBought <= 0) return [];

    const entryPrice = totalCostSTX / totalTokenBought;
    const changePct = ((currentPrice - entryPrice) / entryPrice) * 100;

    const actions: RebalanceAction[] = [];

    // Apply Quantitative Adaptive Stop (ATR & Chandelier Exit)
    const ph = PriceHistoryService.getInstance();
    const high = await ph.computeHigh(token, trailingLookback).catch(() => 0);
    const f = ctx.features?.get(token);

    if (f) {
      const exitPlanner = process.env.NODE_ENV === "test" 
        ? (await import("../quant/exitPlanner.js")).ExitPlanner.getInstance()
        : (await import("../quant/exitPlanner.js")).ExitPlanner.getInstance(); // Ensure ESM works in both environments
      const decision = exitPlanner.computeAdaptiveStop(token, entryPrice, currentPrice, high || currentPrice, f);
      if (decision.shouldExit) {
        actions.push({
          tokenIn: token,
          tokenOut: "STX",
          amountIn: balance.balance,
          direction: "SELL",
          slippageBps,
          reason: decision.reason,
        });
        return actions;
      }
    }

    if (changePct >= tpPct || changePct <= -slPct) {
      actions.push({
        tokenIn: token,
        tokenOut: "STX",
        amountIn: balance.balance,
        direction: "SELL",
        slippageBps,
        reason: `${changePct >= 0 ? "Take profit" : "Stop loss"}: ${token} ${changePct.toFixed(1)}% (WAC entry)`,
      });
      return actions; // Exit early to avoid sending multiple conflicting exit actions
    }

    if (trailingSl > 0 && changePct > 0) {
      if (high > 0) {
        const highChange = ((currentPrice - high) / high) * 100;
        if (highChange <= -trailingSl) {
          actions.push({
            tokenIn: token,
            tokenOut: "STX",
            amountIn: balance.balance,
            direction: "SELL",
            slippageBps,
            reason: `Trailing stop: ${token} -${Math.abs(highChange).toFixed(1)}% from high`,
          });
        }
      }
    }

    return actions;
  }
}
