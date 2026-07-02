import { logger } from "../utils/logger.js";
import { DatabaseService } from "./db.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { RiskManager } from "./riskManager.js";
import { TransactionService } from "./transaction.js";
import { WebSocketManager } from "../api/websocket.js";
import { QueueManager } from "./queue.js";
import type { RebalanceAction } from "../types.js";
import { safeValidateStrategyConfig } from "./strategy/configValidation.js";

// Exported for use by strategyWorker — handles DEX quoting, building, broadcasting,
// and DB/WebSocket bookkeeping for a list of approved actions.
export async function executeApprovedActions(
  actions: RebalanceAction[],
  walletId: number,
  userId: number,
  senderAddress: string,
  slippageBps: number,
): Promise<{ executed: number; attempted: number }> {
  let executed = 0;
  let attempted = 0;
  const registry = DEXRegistry.getInstance();
  const txService = TransactionService.getInstance();
  const db = DatabaseService.getInstance();
  const wss = WebSocketManager.getInstance();

  const settings = await db.findTradeSettings(userId, "personal");
  const useGasless = settings?.useGasless ?? false;

  for (const action of actions) {
    attempted++;
    const bestQuoteResult = await registry.getBestQuote(action.tokenIn, action.tokenOut, action.amountIn);
    if (!bestQuoteResult || bestQuoteResult.quote.amountOut <= 0) continue;

    const { providerName, quote: est } = bestQuoteResult;
    const provider = registry.getProvider(providerName);
    if (!provider) continue;

    if (est.priceImpact > slippageBps / 100) {
      logger.warn("Slippage too high", { priceImpact: est.priceImpact, maxBps: slippageBps, dex: providerName });
      continue;
    }

    const minOut = est.amountOut * (1 - slippageBps / 10000);
    const payload = await provider.buildSwapPayload(action.tokenIn, action.tokenOut, action.amountIn, minOut, senderAddress);
    if (!payload) continue;

    const trade = await db.createTrade({
      walletId, userId,
      direction: action.direction,
      tokenIn: action.tokenIn, tokenOut: action.tokenOut,
      amountIn: action.amountIn, amountOut: est.amountOut,
      feeAmount: est.feeAmount, feeBps: est.feeBps,
    });

    const result = await txService.execute(
      action,
      payload.contractAddress, payload.contractName,
      payload.functionName, payload.functionArgs,
      walletId, senderAddress, est.amountOut, useGasless, payload.postConditions,
    );

    if ("txId" in result) {
      await db.updateTradeStatus(trade.id, "BROADCAST", result.txId);
      wss.broadcastTradeEvent(userId, "trade_broadcast", {
        tradeId: trade.id, txId: result.txId,
        direction: action.direction,
        tokenIn: action.tokenIn, tokenOut: action.tokenOut,
        amountIn: action.amountIn, amountOut: est.amountOut,
        feeAmount: est.feeAmount, feeBps: est.feeBps,
      });
      await QueueManager.getInstance().enqueueConfirmation({ tradeId: trade.id, txId: result.txId, userId });
      executed++;
    } else {
      await db.updateTradeStatus(trade.id, "FAILED", undefined, result.error);
    }
  }

  return { executed, attempted };
}

export class StrategyEngine {
  private static instance: StrategyEngine;

  private constructor() {}

  static getInstance(): StrategyEngine {
    if (!StrategyEngine.instance) {
      StrategyEngine.instance = new StrategyEngine();
    }
    return StrategyEngine.instance;
  }

  // Called by cycleOrchestrator. Enqueues one BullMQ job per (strategy, wallet) pair.
  // The STRATEGY_CYCLE worker handles actual execution concurrently.
  async runCycle(): Promise<{ actionsExecuted: number; totalPnl: number }> {
    const db = DatabaseService.getInstance();
    const registry = DEXRegistry.getInstance();

    const tokens = await registry.getSwappableTokens();
    if (tokens.length === 0) {
      logger.warn("No swappable tokens available");
      return { actionsExecuted: 0, totalPnl: 0 };
    }

    const activeStrategies = await db.prisma.tradingStrategy.findMany({
      where: { isActive: true, agentId: null },
    });

    const activeUserIds = new Set(
      (await db.prisma.user.findMany({ where: { isActive: true }, select: { id: true } }))
        .map(u => u.id)
    );

    const qm = QueueManager.getInstance();
    let enqueued = 0;

    for (const strategy of activeStrategies) {
      if (!activeUserIds.has(strategy.userId)) continue;

      const config = strategy.config as Record<string, unknown>;
      const validatedConfig = safeValidateStrategyConfig(strategy.type, config);
      if (!validatedConfig.success) {
        logger.warn("Skipping strategy with invalid config", { strategyId: strategy.id, strategyType: strategy.type });
        continue;
      }
      const walletIds = Array.isArray(validatedConfig.data.walletIds) ? (validatedConfig.data.walletIds as number[]) : [];

      for (const walletId of walletIds) {
        await qm.enqueueStrategyRun({
          strategyId: strategy.id,
          strategyType: strategy.type,
          userId: strategy.userId,
          walletId,
        });
        enqueued++;
      }
    }

    logger.info("Strategy jobs enqueued", { count: enqueued });

    // PnL summary is computed separately — not blocked by strategy execution.
    let totalPnl = 0;
    const risk = RiskManager.getInstance();
    for (const uid of activeUserIds) {
      totalPnl += await risk.getDailyPnl(uid);
    }

    return { actionsExecuted: 0, totalPnl };
  }

  // Called by AgentService. Same approach — enqueues jobs per strategy/wallet.
  async runStrategies(
    strategies: Array<{ id: number; type: string; config: Record<string, unknown>; userId: number }>,
  ): Promise<{ strategies: number; actions: number }> {
    const qm = QueueManager.getInstance();
    let enqueued = 0;

    for (const strategy of strategies) {
      const validatedConfig = safeValidateStrategyConfig(strategy.type, strategy.config);
      if (!validatedConfig.success) {
        logger.warn("Skipping agent strategy with invalid config", { strategyId: strategy.id, strategyType: strategy.type });
        continue;
      }

      const validatedWalletIds = Array.isArray(validatedConfig.data.walletIds)
        ? (validatedConfig.data.walletIds as number[])
        : [];

      for (const walletId of validatedWalletIds) {
        await qm.enqueueStrategyRun({
          strategyId: strategy.id,
          strategyType: strategy.type,
          userId: strategy.userId,
          walletId,
        });
        enqueued++;
      }
    }

    return { strategies: strategies.length, actions: enqueued };
  }
}
