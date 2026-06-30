import { DatabaseService } from "../db.js";
import { PriceHistoryService } from "../priceHistory.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "./types.js";

export class MeanReversionStrategy implements Strategy {
  async execute(ctx: StrategyContext, _state: StrategyState): Promise<RebalanceAction[]> {
    const { userId, walletId, config, settings } = ctx;
    const maPeriods = (config.maPeriods as number) ?? 20;
    const entryDeviation = (config.entryDeviationPct as number) ?? 5;
    const exitDeviation = (config.exitDeviationPct as number) ?? 1;
    const tokenPair = ((config.tokenPair as string) ?? "STX/sUSDT").split("/");
    const tokenIn = tokenPair[0] ?? "STX";
    const tokenOut = tokenPair[1] ?? "sUSDT";
    const positionSize = (config.positionSizeUsd as number) ?? 10;
    void settings;

    const ph = PriceHistoryService.getInstance();
    const price = await ph.getHistory(tokenOut, 1);
    if (price.length === 0) return [];

    const currentPrice = price[0]!;
    const ma = await ph.computeMovingAverage(tokenOut, maPeriods);
    if (ma === 0) return [];

    const deviation = ((currentPrice - ma) / ma) * 100;
    const db = DatabaseService.getInstance();
    const existing = await db.prisma.trade.findFirst({
      where: { userId, walletId, tokenOut, status: "CONFIRMED" },
    });

    const actions: RebalanceAction[] = [];

    if (deviation < -entryDeviation && !existing) {
      actions.push({
        tokenIn, tokenOut, amountIn: positionSize, direction: "BUY",
        reason: `Mean reversion buy: ${tokenOut} ${deviation.toFixed(1)}% below MA`,
      });
    } else if (deviation > exitDeviation && existing) {
      actions.push({
        tokenIn: tokenOut, tokenOut: tokenIn,
        amountIn: Math.min(positionSize, existing.amountIn),
        direction: "SELL",
        reason: `Mean reversion sell: ${tokenOut} ${deviation.toFixed(1)}% above MA`,
      });
    }

    return actions;
  }
}
