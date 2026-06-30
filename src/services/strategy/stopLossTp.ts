import { DatabaseService } from "../db.js";
import { PriceHistoryService } from "../priceHistory.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "./types.js";

export class StopLossTpStrategy implements Strategy {
  async execute(ctx: StrategyContext, _state: StrategyState): Promise<RebalanceAction[]> {
    const { userId, walletId, config, settings, balances } = ctx;
    const token = ((config.token as string) ?? "").toUpperCase();
    const tpPct = (config.takeProfitPct as number) ?? 10;
    const slPct = (config.stopLossPct as number) ?? 5;
    const trailingSl = (config.trailingStopPct as number) ?? 0;
    void settings;

    if (!token) return [];

    const balance = balances.find(b => b.symbol.toUpperCase() === token);
    if (!balance || balance.balance <= 0) return [];

    const currentPrice = balance.usdValue / balance.balance;
    const db = DatabaseService.getInstance();

    // Improvement: weighted average cost across all confirmed BUY trades for this token,
    // not just the most recent one. This avoids triggering SL/TP on a partial position.
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

    if (changePct >= tpPct || changePct <= -slPct) {
      actions.push({
        tokenIn: token, tokenOut: "STX", amountIn: balance.balance, direction: "SELL",
        reason: `${changePct >= 0 ? "Take profit" : "Stop loss"}: ${token} ${changePct.toFixed(1)}% (WAC entry)`,
      });
    }

    if (trailingSl > 0 && changePct > 0) {
      const ph = PriceHistoryService.getInstance();
      const high = await ph.computeHigh(token, 50);
      if (high > 0) {
        const highChange = ((currentPrice - high) / high) * 100;
        if (highChange <= -trailingSl) {
          actions.push({
            tokenIn: token, tokenOut: "STX", amountIn: balance.balance, direction: "SELL",
            reason: `Trailing stop: ${token} -${Math.abs(highChange).toFixed(1)}% from high`,
          });
        }
      }
    }

    return actions;
  }
}
