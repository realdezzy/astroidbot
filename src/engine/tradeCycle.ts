import { logger } from "../utils/logger.js";
import { DatabaseService } from "../services/db.js";
import { DEXRegistry } from "../services/dex/dexRegistry.js";
import { AIOrchestrator } from "../services/ai.js";
import { PortfolioManager } from "../services/portfolio.js";
import { RiskManager } from "../services/riskManager.js";
import { MarketMakerService } from "../services/marketMaker.js";
import { TransactionService } from "../services/transaction.js";
import { TelegramService } from "../services/telegram.js";
import { WebSocketManager } from "../api/websocket.js";
import { QueueManager } from "../services/queue.js";
import type { SwappableToken } from "../types.js";


interface WalletContext {
  id: number;
  userId: number;
  address: string;
  name: string;
  balance: number;
}

interface TradeSettings {
  slippageBps: number;
  maxPositionPct: number;
  dailyLossLimit: number;
  rebalanceThreshold: number;
}

export async function executeTradeCycle(
  wallet: WalletContext,
  tokens: SwappableToken[],
  settings: TradeSettings
): Promise<number> {
  const db = DatabaseService.getInstance();
  const ai = AIOrchestrator.getInstance();
  const portfolio = PortfolioManager.getInstance();
  const risk = RiskManager.getInstance();
  const marketMaker = MarketMakerService.getInstance();
  const txService = TransactionService.getInstance();
  const wss = WebSocketManager.getInstance();
  const telegram = TelegramService.getInstance();

  const balances = await portfolio.fetchBalances(wallet.address, tokens, wallet.userId);
  if (balances.length === 0) {
    logger.debug("No non-dust balances found", { address: wallet.address });
    return 0;
  }

  const tokenSymbols = balances.map((b) => b.symbol);
  const priceData: Record<string, number[]> = {};
  for (const b of balances) {
    priceData[b.symbol] = [b.usdValue / Math.max(b.balance, 0.001)];
  }

  const sentiment = await ai.analyzeSentiment(wallet.userId, tokenSymbols, priceData);
  const targets = await ai.generatePortfolioTargets(wallet.userId, balances, sentiment);

  const rebalanceActions = portfolio.computeRebalanceActions(balances, targets, settings.rebalanceThreshold);
  const marketMakerActions = await marketMaker.tick(wallet.userId, wallet.id, balances);
  const allActions = [...rebalanceActions, ...marketMakerActions];

  if (allActions.length === 0) {
    logger.debug("No actions required this cycle", { wallet: wallet.name });
    return 0;
  }

  const { approved, rejected } = await risk.evaluateActions(
    wallet.userId,
    allActions,
    balances,
    {
      slippageBps: settings.slippageBps,
      maxPositionPct: settings.maxPositionPct,
      dailyLossLimit: settings.dailyLossLimit,
    }
  );

  for (const r of rejected) {
    logger.info("Action rejected by risk manager", { action: r.action.direction, reason: r.reason });
  }

  let actionsExecuted = 0;

  const registry = DEXRegistry.getInstance();

  for (const action of approved) {
    const bestQuoteResult = await registry.getBestQuote(action.tokenIn, action.tokenOut, action.amountIn);

    if (!bestQuoteResult) {
      logger.warn("No route found on any DEX", { tokenIn: action.tokenIn, tokenOut: action.tokenOut });
      continue;
    }

    const { providerName, quote } = bestQuoteResult;
    const provider = registry.getProvider(providerName);
    if (!provider) continue;

    const minAmountOut = quote.amountOut * (1 - settings.slippageBps / 10000);
    const bestPayload = await provider.buildSwapPayload(
      action.tokenIn,
      action.tokenOut,
      action.amountIn,
      minAmountOut,
      wallet.address
    );

    if (!bestPayload) {
      logger.warn("Failed to build swap payload", { provider: providerName, tokenIn: action.tokenIn, tokenOut: action.tokenOut });
      continue;
    }

    if (quote.priceImpact > settings.slippageBps / 100) {
      logger.warn("Slippage too high", { priceImpact: quote.priceImpact, maxBps: settings.slippageBps, dex: providerName });
      continue;
    }

    logger.info("Enqueuing trade", {
      wallet: wallet.name,
      dex: providerName,
      direction: action.direction,
      tokenIn: action.tokenIn,
      tokenOut: action.tokenOut,
      amountIn: action.amountIn,
      amountOut: quote.amountOut,
      reason: action.reason,
    });

    // Enqueue trade for async execution via BullMQ
    await QueueManager.getInstance().enqueueTrade({
      walletId: wallet.id,
      userId: wallet.userId,
      senderAddress: wallet.address,
      tokenIn: action.tokenIn,
      tokenOut: action.tokenOut,
      amountIn: action.amountIn,
      direction: action.direction,
      reason: action.reason,
    });
    actionsExecuted++;
  }

  return actionsExecuted;
}
