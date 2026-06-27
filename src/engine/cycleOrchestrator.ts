import { logger } from "../utils/logger.js";
import { DatabaseService } from "../services/db.js";
import { DEXRegistry } from "../services/dex/dexRegistry.js";
import { RiskManager } from "../services/riskManager.js";
import { TransactionService } from "../services/transaction.js";
import { TelegramService } from "../services/telegram.js";
import { WebSocketManager } from "../api/websocket.js";
import { BotStatus } from "../types.js";
import { executeLimitOrderCycle } from "./limitOrderCycle.js";
import { StrategyEngine } from "../services/strategyEngine.js";
import { AgentService } from "../services/agentService.js";


export async function runCycle(): Promise<void> {
  const telegram = TelegramService.getInstance();
  const status = telegram.getStatus();

  if (status.status !== BotStatus.RUNNING) {
    logger.info(`Skipping cycle: bot is ${status.status}`);
    return;
  }

  logger.info("Starting bot cycle");

  try {
    const db = DatabaseService.getInstance();
    const registry = DEXRegistry.getInstance();
    const risk = RiskManager.getInstance();
    const txService = TransactionService.getInstance();
    const wss = WebSocketManager.getInstance();

    const tokens = await registry.getSwappableTokens();
    if (tokens.length === 0) {
      logger.warn("No swappable tokens available — skipping cycle");
      return;
    }

    const wallets = await db.prisma.wallet.findMany({
      where: { user: { isActive: true } },
      include: { user: true },
    });

    let totalActionsExecuted = 0;
    let totalDailyPnl = 0;

    // Run strategy engine for users with active strategies (non-agent strategies only)
    const strategyResult = await StrategyEngine.getInstance().runCycle();
    totalActionsExecuted += strategyResult.actionsExecuted;

    // Run agent cycles
    const activeAgents = await db.prisma.tradeAgent.findMany({
      where: { isActive: true },
    });
    if (activeAgents.length > 0) {
      const agentService = AgentService.getInstance();
      for (const agent of activeAgents) {
        agentService.runAgentCycle(agent.id).catch((err) => {
          logger.error("Agent cycle failed", { agentId: agent.id, error: err });
        });
      }
      logger.info("Agent cycles dispatched", { count: activeAgents.length });
    }

    // Retry pending confirmations from previous cycles
    const pendingTrades = await db.findPendingTrades();
    for (const trade of pendingTrades) {
      if (trade.txId && trade.txId !== "dry-run-tx-id") {
        txService.confirmTransaction(trade.txId, trade.id).then((confirmed) => {
          if (confirmed) {
            wss.broadcastTradeEvent(trade.userId, "trade_confirmed", {
              tradeId: trade.id,
              txId: trade.txId,
            });
          }
        }).catch((err) => {
          logger.error("Confirmation retry failed", { tradeId: trade.id, error: err });
        });
      }
    }

    const walletList = wallets.map((w) => ({ id: w.id, userId: w.userId, address: w.address }));
    const { executed: limitOrdersExecuted } = await executeLimitOrderCycle(walletList, tokens);
    totalActionsExecuted += limitOrdersExecuted;

    for (const wallet of wallets) {
      totalDailyPnl += await risk.getDailyPnl(wallet.userId);
    }

    await db.prisma.user.updateMany({
      where: { isActive: true },
      data: { points: { increment: 1 } },
    });

    wss.broadcastCycleComplete({
      actionsExecuted: totalActionsExecuted,
      dailyPnl: totalDailyPnl,
      timestamp: new Date().toISOString(),
    });

    logger.info("Bot cycle complete");
  } catch (error) {
    logger.error("Bot cycle failed", { error });

    if (telegram.isEnabled()) {
      await telegram.sendAlert(
        0,
        `Cycle error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
