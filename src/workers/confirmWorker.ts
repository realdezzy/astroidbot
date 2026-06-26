import type { Job } from "bullmq";
import { DatabaseService } from "../services/db.js";
import { TransactionService } from "../services/transaction.js";
import { WebSocketManager } from "../api/websocket.js";
import { logger } from "../utils/logger.js";


interface ConfirmJob {
  tradeId: number;
  txId: string;
  userId: number;
}

export async function processConfirmJob(job: Job<ConfirmJob>): Promise<void> {
  const { tradeId, txId, userId } = job.data;
  logger.debug(`Confirming trade ${tradeId}`, { txId, attempt: job.attemptsMade });

  const txService = TransactionService.getInstance();
  const db = DatabaseService.getInstance();
  const wss = WebSocketManager.getInstance();

  const confirmed = await txService.confirmTransaction(txId, tradeId);

  if (confirmed) {
    wss.broadcastTradeEvent(userId, "trade_confirmed", { tradeId, txId });
    logger.info(`Trade ${tradeId} confirmed`, { txId });
  } else if (job.attemptsMade >= (job.opts.attempts || 20) - 1) {
    // Last attempt — mark as failed
    await db.updateTradeStatus(tradeId, "FAILED", txId, "Confirmation timed out");
    wss.broadcastTradeEvent(userId, "trade_failed", { tradeId, error: "Confirmation timed out" });
    logger.warn(`Trade ${tradeId} confirmation timed out`, { txId });
    // Don't throw — let the job complete as "done" (we logged the failure)
  } else {
    throw new Error(`Trade ${tradeId} not yet confirmed`);
  }
}
