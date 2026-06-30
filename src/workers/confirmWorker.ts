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

  const state = await txService.confirmTransaction(txId, tradeId);

  if (state === "confirmed") {
    wss.broadcastTradeEvent(userId, "trade_confirmed", { tradeId, txId });
    logger.info(`Trade ${tradeId} confirmed`, { txId });
    return;
  }

  if (state === "failed") {
    wss.broadcastTradeEvent(userId, "trade_failed", { tradeId, txId, error: "Transaction failed or timed out" });
    logger.warn(`Trade ${tradeId} failed`, { txId });
    return;
  }

  // state === "pending"
  const maxAttempts = job.opts.attempts ?? 20;
  if (job.attemptsMade >= maxAttempts - 1) {
    await db.updateTradeStatus(tradeId, "FAILED", txId, "Confirmation timed out");
    wss.broadcastTradeEvent(userId, "trade_failed", { tradeId, error: "Confirmation timed out" });
    logger.warn(`Trade ${tradeId} confirmation timed out after ${maxAttempts} attempts`, { txId });
    return;
  }

  // Throw to trigger BullMQ backoff retry.
  throw new Error(`Trade ${tradeId} not yet confirmed`);
}
