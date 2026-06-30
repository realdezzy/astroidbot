import { DatabaseService } from "../db.js";
import { DEXRegistry } from "../dex/dexRegistry.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "../../types/strategy.js";

export class SniperStrategy implements Strategy {
  async execute(ctx: StrategyContext, _state: StrategyState): Promise<RebalanceAction[]> {
    const { userId, walletId, config, settings, tokens } = ctx;
    const watchTokens = ((config.watchTokens as string) ?? "")
      .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    const maxBuyAmount = (config.maxBuyAmount as number) ?? 1;
    const slippageBps = (config.slippageBps as number) ?? settings.slippageBps;
    const perTokenCap = (config.perTokenCapUsd as number) ?? maxBuyAmount;
    const maxImpact = (config.maxPriceImpactPct as number) ?? 5;
    const cooldown = (config.cooldownMinutes as number) ?? 0;
    void slippageBps;

    if (watchTokens.length === 0) return [];

    const registry = DEXRegistry.getInstance();
    const freshTokens = await registry.getSwappableTokens();
    const db = DatabaseService.getInstance();
    const actions: RebalanceAction[] = [];

    for (const watchSymbol of watchTokens) {
      const token = freshTokens.find(t => t.symbol.toUpperCase() === watchSymbol);
      if (!token) continue;

      const existingTrade = await db.prisma.trade.findFirst({
        where: { userId, walletId, tokenOut: token.symbol, status: "CONFIRMED" },
      });
      if (existingTrade && cooldown <= 0) continue;
      if (existingTrade && cooldown > 0) {
        const elapsed = (Date.now() - existingTrade.createdAt.getTime()) / 60000;
        if (elapsed < cooldown) continue;
      }

      const quote = await registry.getBestQuote("STX", token.symbol, 0.001).catch(() => null);
      if (!quote || quote.quote.amountOut <= 0) continue;
      if (quote.quote.priceImpact > maxImpact) continue;

      actions.push({
        tokenIn: "STX", tokenOut: token.symbol,
        amountIn: Math.min(perTokenCap, maxBuyAmount),
        direction: "BUY",
        reason: `Sniper: auto-buy ${token.symbol}`,
      });
    }

    void tokens;
    return actions;
  }
}
