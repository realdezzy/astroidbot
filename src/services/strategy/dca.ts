import { DatabaseService } from "../db.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "./types.js";

export class DCAStrategy implements Strategy {
  async execute(ctx: StrategyContext, _state: StrategyState): Promise<RebalanceAction[]> {
    const { userId, walletId, config, settings } = ctx;
    const tokenIn = (config.tokenIn as string) ?? "STX";
    const tokenOut = (config.tokenOut as string) ?? "sUSDT";
    const amount = (config.amount as number) ?? 1;
    const intervalMinutes = (config.intervalMinutes as number) ?? 60;
    const priceCondition = (config.priceCondition as string) ?? "always";
    const priceThreshold = (config.priceThresholdUsd as number) ?? 0;
    const endDate = config.endDate as string | undefined;
    const totalBudget = (config.totalBudgetUsd as number) ?? 0;
    const maxSlippage = (config.maxSlippageBps as number) ?? settings.slippageBps;
    void maxSlippage;

    if (endDate && new Date(endDate) < new Date()) return [];

    const db = DatabaseService.getInstance();

    if (totalBudget > 0) {
      const spentTrades = await db.prisma.trade.findMany({
        where: { userId, walletId, tokenOut, direction: "BUY", status: "CONFIRMED" },
      });
      const totalSpent = spentTrades.reduce((s, t) => s + t.amountIn, 0);
      if (totalSpent >= totalBudget) return [];
    }

    // Fix: scope to tokenIn + tokenOut + direction=BUY so manual trades don't pause DCA.
    const lastSlice = await db.prisma.trade.findFirst({
      where: { userId, walletId, tokenIn, tokenOut, direction: "BUY", status: "CONFIRMED" },
      orderBy: { confirmedAt: "desc" },
    });

    if (lastSlice) {
      const elapsed = (Date.now() - lastSlice.createdAt.getTime()) / 60000;
      if (elapsed < intervalMinutes) return [];
    }

    if (priceCondition !== "always" && priceThreshold > 0) {
      const { AlexDEXService } = await import("../dex/alex.js");
      const price = await AlexDEXService.getInstance().getTokenPrice(tokenOut);
      if (priceCondition === "below" && price >= priceThreshold) return [];
      if (priceCondition === "above" && price <= priceThreshold) return [];
    }

    return [{
      tokenIn, tokenOut, amountIn: amount, direction: "BUY",
      reason: `DCA: ${tokenIn}→${tokenOut} ${amount} every ${intervalMinutes}min`,
    }];
  }
}
