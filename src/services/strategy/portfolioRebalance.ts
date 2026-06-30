import { AIOrchestrator } from "../ai.js";
import { DatabaseService } from "../db.js";
import { PortfolioManager } from "../portfolio.js";
import { PriceHistoryService } from "../priceHistory.js";
import { RiskManager } from "../riskManager.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "../../types/strategy.js";

export class PortfolioRebalanceStrategy implements Strategy {
  async execute(ctx: StrategyContext, state: StrategyState): Promise<RebalanceAction[]> {
    const { strategyId, userId, config, balances, settings } = ctx;
    const ai = AIOrchestrator.getInstance();
    const portfolio = PortfolioManager.getInstance();
    const risk = RiskManager.getInstance();
    const db = DatabaseService.getInstance();

    const useAI = config.useAI !== false;
    const tokenUniverse = ((config.tokenUniverse as string) ?? "")
      .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    const minTradeUsd = (config.minTradeUsd as number) ?? 5;
    const threshold = (config.rebalanceThreshold as number) ?? settings.rebalanceThreshold;
    const maxSlippage = (config.maxSlippageBps as number) ?? settings.slippageBps;

    void minTradeUsd; // reserved for future threshold filtering

    const filtered = tokenUniverse.length > 0
      ? balances.filter(b => tokenUniverse.includes(b.symbol.toUpperCase()))
      : balances;

    const refreshMin = (config.aiRefreshMinutes as number) ?? 15;
    const shouldRefresh = useAI && (!state.lastAiRefresh || (Date.now() - state.lastAiRefresh) > refreshMin * 60_000);

    let targets = state.cachedTargets ?? filtered.map(() => ({
      token: filtered[0]?.symbol ?? "STX",
      targetWeight: 1 / Math.max(filtered.length, 1),
    }));

    if (shouldRefresh) {
      const tokenSymbols = filtered.map(b => b.symbol);
      const priceData: Record<string, number[]> = {};
      for (const b of filtered) {
        const history = await PriceHistoryService.getInstance().getHistory(b.symbol, 7);
        priceData[b.symbol] = history.length >= 2 ? history : [b.usdValue / Math.max(b.balance, 0.001)];
      }
      const sentiment = await ai.analyzeSentiment(userId, tokenSymbols, priceData);
      targets = await ai.generatePortfolioTargets(userId, filtered, sentiment);

      state.lastAiRefresh = Date.now();
      state.cachedTargets = targets;

      // Persist updated state immediately so other cycles don't re-call LLM
      await db.prisma.tradingStrategy.update({
        where: { id: strategyId },
        data: { state: state as any },
      });
    }

    const actions = portfolio.computeRebalanceActions(filtered, targets, threshold);
    const { approved } = await risk.evaluateActions(userId, actions, filtered, {
      slippageBps: maxSlippage,
      maxPositionPct: settings.maxPositionPct,
      dailyLossLimit: settings.dailyLossLimit,
    });

    return approved;
  }
}
