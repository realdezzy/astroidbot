import { DatabaseService } from "../db.js";
import { DEXRegistry } from "../dex/dexRegistry.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "../../types/strategy.js";

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

    if (endDate && new Date(endDate) < new Date()) return [];

    const db = DatabaseService.getInstance();
    const registry = DEXRegistry.getInstance();

    if (totalBudget > 0) {
      const spentTrades = await db.prisma.trade.findMany({
        where: { userId, walletId, tokenOut, direction: "BUY", status: "CONFIRMED" },
      });
      // Track total spent in USD (amountOut * current price, or amountIn for STX)
      const tokenOutPrice = await registry.getTokenPrice(tokenOut).catch(() => 0);
      const totalSpent = spentTrades.reduce((sum, t) => {
        // If we bought tokenOut, its USD value at time of trade was approximately what we paid (if STX, amountIn * stx price)
        // Or we can use amountOut * current price as a proxy, or just sum amountIn.
        // Let's sum the amountOut * price as a proxy, or fall back to amountIn if price is not available.
        return sum + (t.amountOut * tokenOutPrice || t.amountIn); // Fallback to amountIn if tokenOutPrice is 0
      }, 0);
      if (totalSpent >= totalBudget) return [];
    }

    const lastSlice = await db.prisma.trade.findFirst({
      where: { userId, walletId, tokenIn, tokenOut, direction: "BUY", status: "CONFIRMED" },
      orderBy: { confirmedAt: "desc" },
    });

    if (lastSlice) {
      // Use confirmedAt instead of createdAt to prevent drift due to slow confirmation times
      const referenceTime = lastSlice.confirmedAt || lastSlice.createdAt;
      const elapsed = (Date.now() - referenceTime.getTime()) / 60000;
      if (elapsed < intervalMinutes) return [];
    }

    if (priceCondition !== "always" && priceThreshold > 0) {
      const price = await registry.getTokenPrice(tokenOut).catch(() => 0);
      if (priceCondition === "below" && price >= priceThreshold) return [];
      if (priceCondition === "above" && price <= priceThreshold) return [];
    }

    return [{
      tokenIn,
      tokenOut,
      amountIn: amount,
      direction: "BUY",
      slippageBps: maxSlippage,
      reason: `DCA: ${tokenIn}→${tokenOut} ${amount} every ${intervalMinutes}min`,
    }];
  }
}
