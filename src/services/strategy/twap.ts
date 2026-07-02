import { DatabaseService } from "../db.js";
import { DEXRegistry } from "../dex/dexRegistry.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "../../types/strategy.js";

export class TwapStrategy implements Strategy {
  async execute(ctx: StrategyContext, _state: StrategyState): Promise<RebalanceAction[]> {
    const { userId, walletId, config, settings } = ctx;
    const tokenIn = (config.tokenIn as string) ?? "STX";
    const tokenOut = (config.tokenOut as string) ?? "sUSDT";
    const totalAmount = (config.totalAmount as number) ?? 1;
    const slices = (config.slices as number) ?? 10;
    const windowMinutes = (config.windowMinutes as number) ?? 60;
    const maxSlippage = (config.maxSlippageBps as number) ?? settings.slippageBps;
    const maxPriceDeviationPct = (config.maxPriceDeviationPct as number) ?? 0;

    const sliceSize = totalAmount / slices;
    const intervalMs = (windowMinutes * 60_000) / slices;

    const db = DatabaseService.getInstance();
    const registry = DEXRegistry.getInstance();

    const completed = await db.prisma.trade.findMany({
      where: { userId, walletId, tokenIn, tokenOut, direction: "BUY", status: "CONFIRMED" },
      orderBy: { confirmedAt: "asc" },
    });

    const totalCompleted = completed.reduce((s, t) => s + t.amountIn, 0);
    if (totalCompleted >= totalAmount) return [];

    // Abort condition check: if price deviates too much from the first slice
    if (maxPriceDeviationPct > 0 && completed.length > 0) {
      const firstTrade = completed[0]!;
      const currentPrice = await registry.getTokenPrice(tokenOut).catch(() => 0);
      const initialPrice = firstTrade.amountIn / (firstTrade.amountOut || 1); // approximate entry price
      if (currentPrice > 0 && initialPrice > 0) {
        const deviation = Math.abs((currentPrice - initialPrice) / initialPrice) * 100;
        if (deviation > maxPriceDeviationPct) {
          return []; // Abort execution of subsequent slices
        }
      }
    }

    const lastSlice = completed[completed.length - 1];
    if (lastSlice) {
      const referenceTime = lastSlice.confirmedAt || lastSlice.createdAt;
      const elapsed = Date.now() - referenceTime.getTime();
      if (elapsed < intervalMs) return [];
    }

    const remaining = totalAmount - totalCompleted;
    const thisSlice = Math.min(sliceSize, remaining);

    return [{
      tokenIn,
      tokenOut,
      amountIn: thisSlice,
      direction: "BUY",
      slippageBps: maxSlippage,
      reason: `TWAP slice: ${tokenIn}→${tokenOut} ${thisSlice.toFixed(4)}`,
    }];
  }
}
