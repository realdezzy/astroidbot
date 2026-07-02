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

    void minTradeUsd;

    const filtered = tokenUniverse.length > 0
      ? balances.filter(b => tokenUniverse.includes(b.symbol.toUpperCase()))
      : balances;

    const totalVal = filtered.reduce((s, b) => s + b.usdValue, 0);

    const refreshMin = (config.aiRefreshMinutes as number) ?? 15;
    const shouldRefresh = useAI && (!state.lastAiRefresh || (Date.now() - state.lastAiRefresh) > refreshMin * 60_000);

    let targets = state.cachedTargets;

    // First-run / fallback seeding when useAI is false or targets are missing
    if (!targets) {
      if (!useAI) {
        // Fallback: use user-configured targetWeights, or default to current weights to avoid random rebalancing
        const configWeights = config.targetWeights as Record<string, number> | undefined;
        if (configWeights) {
          targets = Object.entries(configWeights).map(([symbol, weight]) => ({
            token: symbol.toUpperCase(),
            targetWeight: weight,
          }));
        } else {
          // If no targets configured, target current weights (leads to 0 trades = safe)
          targets = filtered.map(b => ({
            token: b.symbol,
            targetWeight: totalVal > 0 ? b.usdValue / totalVal : 1 / Math.max(filtered.length, 1),
          }));
        }
      } else if (!shouldRefresh) {
        // If AI is enabled but it's not time to refresh yet, and targets are not cached, trigger a refresh immediately
        // instead of equal-weighting.
      }
    }

    if (shouldRefresh || (useAI && !targets)) {
      const tokenSymbols = filtered.map(b => b.symbol);
      const priceData: Record<string, number[]> = {};
      for (const b of filtered) {
        const history = await PriceHistoryService.getInstance().getHistory(b.symbol, 7);
        priceData[b.symbol] = history.length >= 2 ? history : [b.usdValue / Math.max(b.balance, 0.001)];
      }
      try {
        const sentiment = await ai.analyzeSentiment(userId, tokenSymbols, priceData);
        targets = await ai.generatePortfolioTargets(userId, filtered, sentiment);

        state.lastAiRefresh = Date.now();
        state.cachedTargets = targets;

        // Persist updated state immediately so subsequent ticks/workers don't re-call LLM
        await db.prisma.tradingStrategy.update({
          where: { id: strategyId },
          data: { state: state as any },
        });
      } catch (err) {
        // If LLM fetch fails and we have no targets, fall back to current weights (safe) or reuse stale targets
        if (!targets) {
          targets = filtered.map(b => ({
            token: b.symbol,
            targetWeight: totalVal > 0 ? b.usdValue / totalVal : 1 / Math.max(filtered.length, 1),
          }));
        }
      }
    }

    if (!targets || targets.length === 0) return [];

    const actions = portfolio.computeRebalanceActions(filtered, targets, threshold);
    const { approved } = await risk.evaluateActions(userId, actions, filtered, {
      slippageBps: maxSlippage,
      maxPositionPct: settings.maxPositionPct,
      dailyLossLimit: settings.dailyLossLimit,
    });

    return approved;
  }
}
