import { PriceHistoryService } from "../priceHistory.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "../../types/strategy.js";

export class MeanReversionStrategy implements Strategy {
  async execute(ctx: StrategyContext, _state: StrategyState): Promise<RebalanceAction[]> {
    const { config, settings, balances } = ctx;
    const maPeriods = (config.maPeriods as number) ?? 50; // Increased default to 50
    const entryDeviation = (config.entryDeviationPct as number) ?? 5;
    const exitDeviation = (config.exitDeviationPct as number) ?? 1;
    const tokenPair = ((config.tokenPair as string) ?? "STX/sUSDT").split("/");
    const tokenIn = tokenPair[0] ?? "STX";
    const tokenOut = tokenPair[1] ?? "sUSDT";
    const positionSize = (config.positionSizeUsd as number) ?? 10;
    const slippageBps = (config.slippageBps as number) ?? settings.slippageBps;
    const enableTrendFilter = config.enableTrendFilter !== false;

    const ph = PriceHistoryService.getInstance();
    const price = await ph.getHistory(tokenOut, 1);
    if (price.length === 0) return [];

    const currentPrice = price[0]!;
    const ma = await ph.computeMovingAverage(tokenOut, maPeriods);
    if (ma === 0) return [];

    const deviation = ((currentPrice - ma) / ma) * 100;

    // Trend filter: long-term moving average to avoid catching falling knives
    if (enableTrendFilter) {
      const longMa = await ph.computeMovingAverage(tokenOut, maPeriods * 3);
      if (longMa > 0 && currentPrice < longMa * 0.9) {
        // Price is significantly below the long-term MA, indicating a strong downtrend. Skip buy.
        return [];
      }
    }

    const bal = balances.find(b => b.symbol.toUpperCase() === tokenOut.toUpperCase());
    const hasPosition = bal !== undefined && bal.balance > 0.0001;

    const actions: RebalanceAction[] = [];

    if (deviation < -entryDeviation && !hasPosition) {
      actions.push({
        tokenIn,
        tokenOut,
        amountIn: positionSize,
        direction: "BUY",
        slippageBps,
        reason: `Mean reversion buy: ${tokenOut} ${deviation.toFixed(1)}% below MA`,
      });
    } else if (deviation > exitDeviation && hasPosition) {
      actions.push({
        tokenIn: tokenOut,
        tokenOut: tokenIn,
        amountIn: bal!.balance, // Exit full position
        direction: "SELL",
        slippageBps,
        reason: `Mean reversion sell: ${tokenOut} ${deviation.toFixed(1)}% above MA`,
      });
    }

    return actions;
  }
}
