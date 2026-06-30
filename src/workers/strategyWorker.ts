import type { Job } from "bullmq";
import { DatabaseService } from "../services/db.js";
import { DEXRegistry } from "../services/dex/dexRegistry.js";
import { PortfolioManager } from "../services/portfolio.js";
import { PriceHistoryService } from "../services/priceHistory.js";
import { RiskManager } from "../services/riskManager.js";
import { NotificationService } from "../services/notificationService.js";
import { STRATEGY_REGISTRY } from "../services/strategy/registry.js";
import type { StrategyContext, StrategyState } from "../types/strategy.js";
import type { StrategyRunJob } from "../services/queue.js";
import { executeApprovedActions } from "../services/strategyEngine.js";
import { logger } from "../utils/logger.js";


export async function processStrategyJob(job: Job<StrategyRunJob>): Promise<void> {
  const { strategyId, strategyType, userId, walletId } = job.data;

  const StrategyClass = STRATEGY_REGISTRY[strategyType];
  if (!StrategyClass) {
    logger.warn("Unknown strategy type — skipping", { strategyType, strategyId });
    return;
  }

  const db = DatabaseService.getInstance();
  const registry = DEXRegistry.getInstance();

  const strategy = await db.prisma.tradingStrategy.findUnique({ where: { id: strategyId } });
  if (!strategy || !strategy.isActive) return;

  const wallet = await db.prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet || wallet.userId !== userId) return;

  const settings = await db.findTradeSettings(userId, "personal");
  if (!settings) return;

  const tokens = await registry.getSwappableTokens();
  const balances = await PortfolioManager.getInstance().fetchBalances(wallet.address, tokens, userId);
  if (balances.length === 0) return;

  // Record price history (needed by momentum/mean-reversion/etc.)
  for (const b of balances) {
    if (b.usdValue > 0 && b.balance > 0) {
      PriceHistoryService.getInstance().record(b.symbol, b.usdValue / b.balance);
    }
  }

  const config = strategy.config as Record<string, unknown>;
  const state: StrategyState = (strategy.state as StrategyState) ?? {};

  const ctx: StrategyContext = {
    strategyId,
    userId,
    walletId,
    address: wallet.address,
    balances,
    tokens,
    settings,
    config,
  };

  const actions = await new StrategyClass().execute(ctx, state);

  // Persist state mutations written by the strategy (e.g. lastAiRefresh, wasAboveHigh).
  await db.prisma.tradingStrategy.update({
    where: { id: strategyId },
    data: { state: state as any },
  });

  const slippageBps = (config.maxSlippageBps as number) ?? settings.slippageBps;
  const { executed, attempted } = await executeApprovedActions(actions, walletId, userId, wallet.address, slippageBps);

  if (attempted > 0 && executed === 0) {
    await handleStrategyFailure(strategyId, userId, "All trade executions failed in the cycle", db);
  } else {
    await db.prisma.tradingStrategy.update({
      where: { id: strategyId },
      data: { failureCount: 0 },
    });
  }

  logger.info("Strategy job complete", { strategyId, strategyType, executed, attempted });
}

async function handleStrategyFailure(
  strategyId: number,
  userId: number,
  errorMsg: string,
  db: ReturnType<typeof DatabaseService.getInstance>
): Promise<void> {
  const strategy = await db.prisma.tradingStrategy.findUnique({ where: { id: strategyId } });
  if (!strategy) return;

  const newFailureCount = strategy.failureCount + 1;
  if (newFailureCount >= 5) {
    await db.prisma.tradingStrategy.update({
      where: { id: strategyId },
      data: { failureCount: newFailureCount, isActive: false },
    });
    await db.prisma.auditLog.create({
      data: {
        userId,
        action: "STRATEGY_AUTO_DISABLE",
        details: `Strategy ${strategy.type} (ID: ${strategyId}) disabled after 5 failures. Last: ${errorMsg}`,
      },
    });
    await NotificationService.getInstance().send({
      userId,
      title: "Strategy Automatically Disabled",
      message: `Your ${strategy.type} strategy has been disabled due to 5 consecutive failures. Last failure: ${errorMsg}`,
      type: "ERROR",
    });
  } else {
    await db.prisma.tradingStrategy.update({
      where: { id: strategyId },
      data: { failureCount: newFailureCount },
    });
  }
}
