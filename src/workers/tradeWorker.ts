import type { Job } from "bullmq";
import { QueueManager } from "../services/queue.js";
import { DatabaseService } from "../services/db.js";
import { DEXRegistry } from "../services/dex/dexRegistry.js";
import { RiskManager } from "../services/riskManager.js";
import { TelegramService } from "../services/telegram.js";
import { WebSocketManager } from "../api/websocket.js";
import { logger } from "../utils/logger.js";
import { executeSwapPayload } from "../services/chains/executeSwap.js";
import { walletChainId } from "../services/chains/walletChain.js";
import { DEFAULT_CHAIN_ID } from "../services/chains/descriptors/index.js";
import { resolveTradeSettings } from "../services/tradeSettings.js";
import { PortfolioManager } from "../services/portfolio.js";


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
  const wss = WebSocketManager.getInstance();
  const qm = QueueManager.getInstance();

  const wallet = await db.findWalletById(walletId);
  const chainId = wallet ? walletChainId(wallet) : DEFAULT_CHAIN_ID;

  // Find best route across DEXs registered for this wallet's chain
  const bestQuote = await registry.getBestQuote(tokenIn, tokenOut, amountIn, chainId);
  if (!bestQuote || bestQuote.quote.amountOut <= 0) {
    throw new Error(`No viable swap route: ${tokenIn} → ${tokenOut}`);
  }

  // Pre-execution risk check, against this wallet's chain rather than the
  // account's. Slippage is the setting that differs per chain, and it is the
  // one this check is about.
  const settings = await resolveTradeSettings(userId, "personal", chainId);

  // Real balances, not a synthetic stand-in. This argument used to be
  // `[{ token: tokenIn, symbol: tokenIn, balance: amountIn, usdValue: amountIn }]`,
  // which made the traded amount both the position and the whole portfolio: the
  // position check was `amountIn / amountIn` and therefore always exactly 100%,
  // so every buy breached `maxPositionPct` and every sell breached the 50% sell
  // ceiling. The queue rejected every trade routed through it — which is every
  // surface but the inline web path — while `RiskManager`'s own tests stayed
  // green, because the unit was right and only its caller was wrong.
  const tokens = await registry.getSwappableTokens(false, chainId);
  const balances = wallet
    ? await PortfolioManager.getInstance().fetchBalances(wallet.address, tokens, userId, true, chainId)
    : [];

  const riskResult = await RiskManager.getInstance().evaluateTrade(
    userId,
    { tokenIn, tokenOut, amountIn, direction: direction as "BUY" | "SELL", reason },
    balances,
    { slippageBps: settings.slippageBps, maxPositionPct: settings.maxPositionPct, dailyLossLimit: settings.dailyLossLimit }
  );
  if (!riskResult.approved) {
    logger.warn(`Trade rejected by risk manager: ${riskResult.reason}`, { tokenIn, tokenOut, amountIn });
    throw new Error(`Risk: ${riskResult.reason}`);
  }

  const { providerName, quote: est } = bestQuote;
  const provider = registry.getProvider(providerName);
  if (!provider) throw new Error(`Provider not found: ${providerName}`);

  const minOut = est.amountOut * (1 - settings.slippageBps / 10000);
  const payload = await provider.buildSwapPayload(tokenIn, tokenOut, amountIn, minOut, senderAddress);
  if (!payload) throw new Error("Failed to build swap payload");

  // A job that died after broadcasting still has attempts left, and BullMQ
  // will replay it. Without this check the replay wrote a second Trade row and
  // sent a second swap — the user paid twice for one intent. The job id is the
  // caller's idempotency key, so a prior attempt's row is findable by it.
  //
  // Only a recorded `txId` blocks the retry. A row with no txId means the
  // previous attempt died before broadcasting, so the retry is the point: it
  // reuses that row rather than orphaning it.
  const idempotencyKey = typeof job.id === "string" ? job.id : undefined;
  const prior = idempotencyKey ? await db.findTradeByIdempotencyKey(idempotencyKey) : null;

  if (prior?.txId) {
    logger.warn("Trade job replayed after broadcast; refusing to broadcast again", {
      jobId: job.id, tradeId: prior.id, txId: prior.txId,
    });
    return;
  }

  const trade = prior ?? await db.createTrade({
    walletId, userId, direction, tokenIn, tokenOut,
    amountIn, amountOut: est.amountOut,
    feeAmount: est.feeAmount, feeBps: est.feeBps,
    idempotencyKey,
  });

  const result = await executeSwapPayload(payload, {
    action: { tokenIn, tokenOut, amountIn, direction: direction as "BUY" | "SELL", reason },
    walletId,
    senderAddress,
    maxOutbound: est.amountOut,
    useGasless: settings?.useGasless ?? false,
    chainId,
  });

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
