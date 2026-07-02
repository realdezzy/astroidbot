import type { Job } from "bullmq";
import { DatabaseService } from "../services/db.js";
import { DEXRegistry } from "../services/dex/dexRegistry.js";
import { PortfolioManager } from "../services/portfolio.js";
import { PriceHistoryService } from "../services/priceHistory.js";
import { RiskManager } from "../services/riskManager.js";
import { NotificationService } from "../services/notificationService.js";
import { STRATEGY_REGISTRY } from "../services/strategy/registry.js";
import { MarketDataService } from "../services/quant/marketData.js";
import { FeatureEngine } from "../services/quant/featureEngine.js";
import { RegimeDetectionService } from "../services/quant/regimeDetection.js";
import { SignalFusionService } from "../services/quant/signalFusion.js";
import { PortfolioOptimizer } from "../services/quant/portfolioOptimizer.js";
import { AIOrchestrator } from "../services/ai.js";
import { ConfigManager } from "../config.js";
import type { StrategyContext, StrategyState } from "../types/strategy.js";
import type { StrategyRunJob } from "../services/queue.js";
import { executeApprovedActions } from "../services/strategyEngine.js";
import { logger } from "../utils/logger.js";
import { safeValidateStrategyConfig } from "../services/strategy/configValidation.js";


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

  // Load the associated TradeAgent (if any) to check the aiMode setting.
  let aiMode = "off";
  if (strategy.agentId) {
    const agent = await db.prisma.tradeAgent.findUnique({ where: { id: strategy.agentId } });
    if (agent) aiMode = agent.aiMode;
  } else {
    const activeAgent = await db.prisma.tradeAgent.findFirst({
      where: { userId, isActive: true }
    });
    if (activeAgent) aiMode = activeAgent.aiMode;
  }

  const tokens = await registry.getSwappableTokens();
  const tokenSymbols = tokens.map(t => t.symbol);
  const balances = await PortfolioManager.getInstance().fetchBalances(wallet.address, tokens, userId);
  if (balances.length === 0) return;

  // Record price history (needed by momentum/mean-reversion/etc.)
  for (const b of balances) {
    if (b.usdValue > 0 && b.balance > 0) {
      PriceHistoryService.getInstance().record(b.symbol, b.usdValue / b.balance);
    }
  }

  const validation = safeValidateStrategyConfig(strategy.type, strategy.config as Record<string, unknown>);
  if (!validation.success) {
    logger.warn("Strategy job skipped because config is invalid", { strategyId, strategyType, error: validation.error.flatten() });
    await handleStrategyFailure(strategyId, userId, "Invalid strategy config", db);
    return;
  }

  const config = validation.data as Record<string, unknown>;

  // Build quantitative market context for this cycle.
  const marketContext = await MarketDataService.getInstance().getContext(tokenSymbols).catch(() => undefined);
  const featureEngine = FeatureEngine.getInstance();
  const featuresMap = new Map<string, import("../services/quant/featureEngine.js").Features>();
  for (const symbol of tokenSymbols) {
    try {
      featuresMap.set(symbol, await featureEngine.compute(symbol));
    } catch { }
  }

  // Regime gate: determine the primary token for this strategy and suppress if incompatible.
  const primaryToken = (config.tokenOut ?? config.token ?? tokenSymbols[0] ?? "STX") as string;
  const regimeService = RegimeDetectionService.getInstance();
  const regimeAllowed = await regimeService.isStrategyAllowed(strategy.type, primaryToken);
  if (!regimeAllowed) {
    const regime = await regimeService.detectRegime(primaryToken);
    logger.info("Strategy suppressed by regime gate", { strategyId, strategyType: strategy.type, regime, token: primaryToken });
    return;
  }

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
    marketContext,
    features: featuresMap,
  };

  const actions = await new StrategyClass().execute(ctx, state);

  // Apply Quantitative Signal Fusion & Portfolio Sizing
  const signalFusion = SignalFusionService.getInstance();
  const portfolioOptimizer = PortfolioOptimizer.getInstance();
  const aiOrchestrator = AIOrchestrator.getInstance();
  const totalWalletValueUsd = balances.reduce((sum, b) => sum + b.usdValue, 0);

  const sizedActions = await Promise.all(actions.map(async (action) => {
    if (action.direction === "BUY") {
      const f = featuresMap.get(action.tokenOut);
      if (f) {
        let forecast = signalFusion.fuse(strategyId, action.tokenOut, f);

        // AI Analyst Audit Layer: audit the consensus forecast if AI is enabled
        if (aiMode !== "off" && ConfigManager.getInstance().config.OPENAI_API_KEY) {
          const audit = await aiOrchestrator.auditSignal(userId, action.tokenOut, "BUY", forecast.confidence, {
            currentPrice: f.currentPrice,
            rsi14: f.rsi14,
            macdHistogram: f.macdHistogram,
            historicalVolatility: f.historicalVolatility,
            return24h: f.return24h,
          });
          logger.info("AI Analyst audited strategy signal", { token: action.tokenOut, multiplier: audit.confidenceMultiplier, rationale: audit.rationale });
          forecast.confidence = forecast.confidence * audit.confidenceMultiplier;
          forecast.rationale.push(`AI Audit: ${audit.rationale} (multiplier: ${audit.confidenceMultiplier})`);
        }

        // If the fused consensus signal is HOLD or SELL (divergent from BUY), down-scale or skip the buy.
        if (forecast.direction !== "BUY" || forecast.confidence < 0.15) {
          logger.info("Down-scaling BUY action because consensus signal is not bullish or confidence is too low", { token: action.tokenOut, score: forecast.direction, confidence: forecast.confidence });
          return {
            ...action,
            amountIn: action.amountIn * 0.1, // downscale by 90%
            reason: `${action.reason} [Fused Downscale: non-bullish/low-confidence consensus]`,
          };
        }

        const optimizedAmount = portfolioOptimizer.optimizeSizing(
          "BUY",
          action.amountIn,
          f,
          forecast,
          totalWalletValueUsd,
          settings.maxPositionPct
        );

        logger.info("Sized trade action using Kelly/Risk Parity", {
          token: action.tokenOut,
          original: action.amountIn,
          optimized: optimizedAmount,
          confidence: forecast.confidence.toFixed(2),
        });

        return {
          ...action,
          amountIn: optimizedAmount,
          reason: `${action.reason} [Kelly/Vol Sized]`,
        };
      }
    }
    return action;
  }));

  // Persist state mutations written by the strategy (e.g. lastAiRefresh, wasAboveHigh).
  await db.prisma.tradingStrategy.update({
    where: { id: strategyId },
    data: { state: state as any },
  });

  const slippageBps = (config.maxSlippageBps as number) ?? settings.slippageBps;
  const { executed, attempted } = await executeApprovedActions(sizedActions, walletId, userId, wallet.address, slippageBps);

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
