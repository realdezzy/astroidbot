import { DatabaseService } from "../db.js";
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
    void maxSlippage;

    const sliceSize = totalAmount / slices;
    const intervalMs = (windowMinutes * 60_000) / slices;

    const db = DatabaseService.getInstance();

    // Fix: scope to tokenIn + tokenOut + direction=BUY so manual trades don't reset TWAP timing.
    const lastSlice = await db.prisma.trade.findFirst({
      where: { userId, walletId, tokenIn, tokenOut, direction: "BUY", status: "CONFIRMED" },
      orderBy: { confirmedAt: "desc" },
    });

    if (lastSlice) {
      const elapsed = Date.now() - lastSlice.createdAt.getTime();
      if (elapsed < intervalMs) return [];
    }

    const completed = await db.prisma.trade.findMany({
      where: { userId, walletId, tokenIn, tokenOut, direction: "BUY", status: "CONFIRMED" },
    });
    const totalCompleted = completed.reduce((s, t) => s + t.amountIn, 0);
    if (totalCompleted >= totalAmount) return [];

    const remaining = totalAmount - totalCompleted;
    const thisSlice = Math.min(sliceSize, remaining);

    return [{
      tokenIn, tokenOut, amountIn: thisSlice, direction: "BUY",
      reason: `TWAP slice: ${tokenIn}→${tokenOut} ${thisSlice.toFixed(4)}`,
    }];
  }
}
