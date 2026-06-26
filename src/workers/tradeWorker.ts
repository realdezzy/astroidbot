import type { Job } from "bullmq";
import { QueueManager, QUEUES } from "../services/queue.js";
import { DatabaseService } from "../services/db.js";
import { DEXRegistry } from "../services/dex/dexRegistry.js";
import { TransactionService } from "../services/transaction.js";
import { RiskManager } from "../services/riskManager.js";
import { TelegramService } from "../services/telegram.js";
import { WebSocketManager } from "../api/websocket.js";
import { logger } from "../utils/logger.js";


interface TradeJob {
  walletId: number;
  userId: number;
  senderAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  direction: "BUY" | "SELL";
  reason: string;
}

export async function processTradeJob(job: Job<TradeJob>): Promise<void> {
  const { walletId, userId, senderAddress, tokenIn, tokenOut, amountIn, direction, reason } = job.data;
  logger.info(`Processing trade job ${job.id}`, { direction, tokenIn, tokenOut, amountIn });

  const db = DatabaseService.getInstance();
  const registry = DEXRegistry.getInstance();
  const txService = TransactionService.getInstance();
  const wss = WebSocketManager.getInstance();
  const qm = QueueManager.getInstance();

  // Find best route across all DEXs
  const bestQuote = await registry.getBestQuote(tokenIn, tokenOut, amountIn);
  if (!bestQuote || bestQuote.quote.amountOut <= 0) {
    throw new Error(`No viable swap route: ${tokenIn} → ${tokenOut}`);
  }

  // Pre-execution risk check
  const settings = await db.findTradeSettings(userId, "personal");
  if (settings) {
    const riskResult = await RiskManager.getInstance().evaluateTrade(
      userId,
      { tokenIn, tokenOut, amountIn, direction: direction as "BUY" | "SELL", reason },
      [{ token: tokenIn, symbol: tokenIn, balance: amountIn, usdValue: amountIn }],
      { slippageBps: settings.slippageBps, maxPositionPct: settings.maxPositionPct, dailyLossLimit: settings.dailyLossLimit }
    );
    if (!riskResult.approved) {
      logger.warn(`Trade rejected by risk manager: ${riskResult.reason}`, { tokenIn, tokenOut, amountIn });
      throw new Error(`Risk: ${riskResult.reason}`);
    }
  }

  const { providerName, quote: est } = bestQuote;
  const provider = registry.getProvider(providerName);
  if (!provider) throw new Error(`Provider not found: ${providerName}`);

  const minOut = est.amountOut * (1 - (settings?.slippageBps ?? 100) / 10000);
  const payload = await provider.buildSwapPayload(tokenIn, tokenOut, amountIn, minOut, senderAddress);
  if (!payload) throw new Error("Failed to build swap payload");

  const trade = await db.createTrade({
    walletId, userId, direction, tokenIn, tokenOut,
    amountIn, amountOut: est.amountOut,
    feeAmount: est.feeAmount, feeBps: est.feeBps,
  });

  const result = await txService.execute(
    { tokenIn, tokenOut, amountIn, direction: direction as "BUY" | "SELL", reason },
    payload.contractAddress, payload.contractName,
    payload.functionName, payload.functionArgs,
    walletId, senderAddress, est.amountOut, false, payload.postConditions,
  );

  if ("txId" in result) {
    await db.updateTradeStatus(trade.id, "BROADCAST", result.txId);

    wss.broadcastTradeEvent(userId, "trade_broadcast", {
      tradeId: trade.id, txId: result.txId,
      direction, tokenIn, tokenOut,
      amountIn, amountOut: est.amountOut,
      feeAmount: est.feeAmount, feeBps: est.feeBps,
    });

    const telegram = TelegramService.getInstance();
    if (telegram.isEnabled()) {
      await telegram.sendAlert(userId,
        `Trade: ${direction} ${amountIn} ${tokenIn} → ${est.amountOut.toFixed(4)} ${tokenOut}\nFee: ${est.feeAmount.toFixed(4)} (${est.feeBps} bps) | TX: ${result.txId}`
      );
    }

    await qm.enqueueConfirmation({ tradeId: trade.id, txId: result.txId, userId });

    logger.info(`Trade executed: ${direction} ${amountIn} ${tokenIn} → ${est.amountOut} ${tokenOut}`, {
      tradeId: trade.id, txId: result.txId, dex: providerName,
    });
  } else {
    await db.updateTradeStatus(trade.id, "FAILED", undefined, result.error);
    wss.broadcastTradeEvent(userId, "trade_failed", { tradeId: trade.id, error: result.error });
    throw new Error(result.error);
  }
}
