import axios from "axios";
import { logger } from "../utils/logger.js";
import { ConfigManager } from "../config.js";
import { DatabaseService } from "./db.js";
import { AIOrchestrator } from "./ai.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { PortfolioManager } from "./portfolio.js";
import { MarketMakerService } from "./marketMaker.js";
import { RiskManager } from "./riskManager.js";
import { TransactionService } from "./transaction.js";
import { PriceHistoryService } from "./priceHistory.js";
import { WebSocketManager } from "../api/websocket.js";
import { NotificationService } from "./notificationService.js";
import type { RebalanceAction, TokenBalance, SwappableToken, AISentimentResult, PortfolioTarget } from "../types.js";

export class StrategyEngine {
  private static instance: StrategyEngine;

  private constructor() {}

  static getInstance(): StrategyEngine {
    if (!StrategyEngine.instance) {
      StrategyEngine.instance = new StrategyEngine();
    }
    return StrategyEngine.instance;
  }

  private async handleStrategySuccess(strategyId: number): Promise<void> {
    const db = DatabaseService.getInstance();
    await db.prisma.tradingStrategy.update({
      where: { id: strategyId },
      data: { failureCount: 0 },
    });
  }

  private async handleStrategyFailure(strategyId: number, userId: number, errorMsg: string): Promise<void> {
    const db = DatabaseService.getInstance();
    const strategy = await db.prisma.tradingStrategy.findUnique({
      where: { id: strategyId },
    });
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
          details: `Strategy ${strategy.type} (ID: ${strategyId}) automatically disabled after 5 consecutive failures. Last error: ${errorMsg}`,
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
        .map((u) => u.id)
    );

    let actionsExecuted = 0;
    let totalPnl = 0;

    for (const strategy of activeStrategies) {
      if (!activeUserIds.has(strategy.userId)) continue;

      const config = strategy.config as Record<string, unknown>;
      const strategyWalletIds = Array.isArray(config.walletIds)
        ? (config.walletIds as number[])
        : [];

      if (strategyWalletIds.length === 0) continue;

      const settings = await db.findTradeSettings(strategy.userId, "personal");
      if (!settings) continue;

      for (const walletId of strategyWalletIds) {
        const wallet = await db.prisma.wallet.findUnique({ where: { id: walletId } });
        if (!wallet || wallet.userId !== strategy.userId) continue;

        const balances = await PortfolioManager.getInstance().fetchBalances(
          wallet.address, tokens, strategy.userId
        );
        if (balances.length === 0) continue;

        try {
          const result = await this.executeStrategy(
            strategy.id,
            strategy.type,
            config,
            strategy.userId,
            wallet.id,
            wallet.address,
            balances,
            tokens,
            settings,
          );
          actionsExecuted += result.executed;

          if (result.attempted > 0 && result.executed === 0) {
            await this.handleStrategyFailure(strategy.id, strategy.userId, "All trade executions failed in the cycle");
          } else {
            await this.handleStrategySuccess(strategy.id);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error(`Strategy ${strategy.type} failed`, { userId: strategy.userId, walletId: wallet.id, error });
          await this.handleStrategyFailure(strategy.id, strategy.userId, errorMsg);
        }
      }

      totalPnl += await RiskManager.getInstance().getDailyPnl(strategy.userId);
    }

    return { actionsExecuted, totalPnl };
  }

  async runStrategies(
    strategies: Array<{ id: number; type: string; config: Record<string, unknown>; userId: number }>,
  ): Promise<{ strategies: number; actions: number }> {
    const db = DatabaseService.getInstance();
    const registry = DEXRegistry.getInstance();

    const tokens = await registry.getSwappableTokens();
    if (tokens.length === 0) return { strategies: 0, actions: 0 };

    let strategiesRun = 0;
    let actionsExecuted = 0;

    for (const strategy of strategies) {
      const config = strategy.config;
      const walletIds = Array.isArray(config.walletIds) ? (config.walletIds as number[]) : [];
      if (walletIds.length === 0) continue;

      const settings = await db.findTradeSettings(strategy.userId, "personal");
      if (!settings) continue;

      let ranAtLeastOne = false;
      for (const walletId of walletIds) {
        const wallet = await db.prisma.wallet.findUnique({ where: { id: walletId } });
        if (!wallet || wallet.userId !== strategy.userId) continue;

        const balances = await PortfolioManager.getInstance().fetchBalances(
          wallet.address, tokens, strategy.userId,
        );
        if (balances.length === 0) continue;

        try {
          const result = await this.executeStrategy(
            strategy.id,
            strategy.type,
            config,
            strategy.userId,
            wallet.id,
            wallet.address,
            balances,
            tokens,
            settings,
          );
          actionsExecuted += result.executed;
          ranAtLeastOne = true;

          if (result.attempted > 0 && result.executed === 0) {
            await this.handleStrategyFailure(strategy.id, strategy.userId, "All trade executions failed in the cycle");
          } else {
            await this.handleStrategySuccess(strategy.id);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error(`Agent strategy ${strategy.type} failed`, {
            userId: strategy.userId, walletId, error,
          });
          await this.handleStrategyFailure(strategy.id, strategy.userId, errorMsg);
        }
      }

      if (ranAtLeastOne) strategiesRun += 1;
    }

    return { strategies: strategiesRun, actions: actionsExecuted };
  }

  private async executeStrategy(
    strategyId: number,
    type: string,
    config: Record<string, unknown>,
    userId: number,
    walletId: number,
    address: string,
    balances: TokenBalance[],
    tokens: SwappableToken[],
    settings: { slippageBps: number; maxPositionPct: number; dailyLossLimit: number; rebalanceThreshold: number },
  ): Promise<{ executed: number; attempted: number }> {
    // Record price history for all tokens (needed by momentum/mean-reversion/etc.)
    for (const b of balances) {
      if (b.usdValue > 0 && b.balance > 0) {
        PriceHistoryService.getInstance().record(b.symbol, b.usdValue / b.balance);
      }
    }

    let res: any;
    switch (type) {
      case "portfolio_rebalance": res = await this.runPortfolioRebalance(strategyId, userId, walletId, address, balances, tokens, config, settings); break;
      case "grid": res = await this.runGrid(userId, walletId, address, balances, config, settings); break;
      case "dca": res = await this.runDCA(config, userId, walletId, address, settings); break;
      case "sniper": res = await this.runSniper(config, userId, walletId, address, settings, tokens); break;
      case "copy": res = await this.runCopy(config, userId, walletId, address, settings, tokens); break;
      case "momentum": res = await this.runMomentum(config, userId, walletId, address, settings, tokens); break;
      case "mean_reversion": res = await this.runMeanReversion(config, userId, walletId, address, settings); break;
      case "twap": res = await this.runTWAP(config, userId, walletId, address, settings); break;
      case "stop_loss_tp": res = await this.runStopLossTP(config, userId, walletId, address, settings, balances); break;
      case "rotational": res = await this.runRotational(config, userId, walletId, address, settings, tokens); break;
      case "breakout": res = await this.runBreakout(config, userId, walletId, address, settings); break;
      default: res = { executed: 0, attempted: 0 }; break;
    }
    const executed = res.executed ?? 0;
    const attempted = res.attempted ?? res.executed ?? 0;
    return { executed, attempted };
  }

  // ── AI refresh helper: only call LLM when enough time has elapsed ──
  private async shouldRefreshAI(
    config: Record<string, unknown>,
    db: ReturnType<typeof DatabaseService.getInstance>,
    strategyId: number,
  ): Promise<boolean> {
    const refreshMin = (config.aiRefreshMinutes as number) ?? 15;
    const useAI = config.useAI !== false;
    if (!useAI) return false;

    const strategy = await db.prisma.tradingStrategy.findUnique({ where: { id: strategyId } });
    if (!strategy) return true;
    const existingConfig = strategy.config as Record<string, unknown>;
    const lastRefresh = existingConfig._lastAiRefresh as number | undefined;
    if (!lastRefresh) return true;
    return (Date.now() - lastRefresh) > refreshMin * 60_000;
  }

  private async markAIRefreshed(db: ReturnType<typeof DatabaseService.getInstance>, strategyId: number): Promise<void> {
    const strategy = await db.prisma.tradingStrategy.findUnique({ where: { id: strategyId } });
    if (!strategy) return;
    const config = (strategy.config as Record<string, unknown>) ?? {};
    config._lastAiRefresh = Date.now();
    await db.prisma.tradingStrategy.update({
      where: { id: strategyId },
      data: { config: config as any },
    });
  }

  // ════════════════════ EXISTING STRATEGIES (EXPANDED) ════════════════════

  private async runPortfolioRebalance(
    strategyId: number,
    userId: number, walletId: number, address: string,
    balances: TokenBalance[], tokens: SwappableToken[],
    config: Record<string, unknown>,
    settings: { slippageBps: number; maxPositionPct: number; dailyLossLimit: number; rebalanceThreshold: number },
  ): Promise<{ executed: number }> {
    const ai = AIOrchestrator.getInstance();
    const portfolio = PortfolioManager.getInstance();
    const risk = RiskManager.getInstance();
    const db = DatabaseService.getInstance();
    const useAI = config.useAI !== false;
    const tokenUniverse = (config.tokenUniverse as string || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    const minTradeUsd = (config.minTradeUsd as number) ?? 5;
    const threshold = (config.rebalanceThreshold as number) ?? settings.rebalanceThreshold;
    const maxSlippage = (config.maxSlippageBps as number) ?? settings.slippageBps;

    const filtered = tokenUniverse.length > 0
      ? balances.filter(b => tokenUniverse.includes(b.symbol.toUpperCase()))
      : balances;

    let targets: PortfolioTarget[];

    if (useAI && await this.shouldRefreshAI(config, db, strategyId)) {
      const tokenSymbols = filtered.map(b => b.symbol);
      const priceData: Record<string, number[]> = {};
      for (const b of filtered) {
        const history = await PriceHistoryService.getInstance().getHistory(b.symbol, 7);
        priceData[b.symbol] = history.length >= 2 ? history : [b.usdValue / Math.max(b.balance, 0.001)];
      }
      const sentiment = await ai.analyzeSentiment(userId, tokenSymbols, priceData);
      targets = await ai.generatePortfolioTargets(userId, filtered, sentiment);
      await this.markAIRefreshed(db, strategyId);
    } else if (config._lastTargets) {
      targets = config._lastTargets as PortfolioTarget[];
    } else {
      targets = filtered.map(() => ({ token: filtered[0]?.symbol ?? "STX", targetWeight: 1 / filtered.length }));
    }

    const actions = portfolio.computeRebalanceActions(filtered, targets, threshold);

    const { approved } = await risk.evaluateActions(userId, actions, filtered, {
      slippageBps: maxSlippage, maxPositionPct: settings.maxPositionPct, dailyLossLimit: settings.dailyLossLimit,
    });

    return this.executeApprovedActions(approved, walletId, userId, address, maxSlippage);
  }

  private async runGrid(
    userId: number, walletId: number, address: string,
    balances: TokenBalance[],
    config: Record<string, unknown>,
    settings: { slippageBps: number; maxPositionPct: number; dailyLossLimit: number; rebalanceThreshold: number },
  ): Promise<{ executed: number }> {
    const mm = MarketMakerService.getInstance();
    const actions = await mm.tick(userId, walletId, balances);
    if (actions.length === 0) return { executed: 0 };
    const slippage = (config.slippageBps as number) ?? settings.slippageBps;
    return this.executeApprovedActions(actions, walletId, userId, address, slippage);
  }

  private async runDCA(
    config: Record<string, unknown>,
    userId: number, walletId: number, address: string,
    settings: { slippageBps: number; maxPositionPct: number; dailyLossLimit: number; rebalanceThreshold: number },
  ): Promise<{ executed: number }> {
    const tokenIn = (config.tokenIn as string) ?? "STX";
    const tokenOut = (config.tokenOut as string) ?? "sUSDT";
    const amount = (config.amount as number) ?? 1;
    const intervalMinutes = (config.intervalMinutes as number) ?? 60;
    const priceCondition = (config.priceCondition as string) ?? "always";
    const priceThreshold = (config.priceThresholdUsd as number) ?? 0;
    const endDate = config.endDate as string | undefined;
    const totalBudget = (config.totalBudgetUsd as number) ?? 0;
    const maxSlippage = (config.maxSlippageBps as number) ?? settings.slippageBps;

    if (endDate && new Date(endDate) < new Date()) return { executed: 0 };

    const db = DatabaseService.getInstance();
    if (totalBudget > 0) {
      const spentTrades = await db.prisma.trade.findMany({
        where: { userId, walletId, tokenOut, status: "CONFIRMED" },
      });
      const totalSpent = spentTrades.reduce((s, t) => s + t.amountIn, 0);
      if (totalSpent >= totalBudget) return { executed: 0 };
    }

    const lastTrade = await db.prisma.trade.findFirst({
      where: { userId, walletId, status: "CONFIRMED" },
      orderBy: { createdAt: "desc" },
    });

    if (lastTrade) {
      const elapsed = (Date.now() - lastTrade.createdAt.getTime()) / 60000;
      if (elapsed < intervalMinutes) return { executed: 0 };
    }

    if (priceCondition !== "always" && priceThreshold > 0) {
      const alex = (await import("./dex/alex.js")).AlexDEXService.getInstance();
      const price = await alex.getTokenPrice(tokenOut);
      if (priceCondition === "below" && price >= priceThreshold) return { executed: 0 };
      if (priceCondition === "above" && price <= priceThreshold) return { executed: 0 };
    }

    const action: RebalanceAction = {
      tokenIn, tokenOut, amountIn: amount, direction: "BUY",
      reason: `DCA: ${tokenIn}→${tokenOut} ${amount} every ${intervalMinutes}min`,
    };

    return this.executeApprovedActions([action], walletId, userId, address, maxSlippage);
  }

  private async runSniper(
    config: Record<string, unknown>,
    userId: number, walletId: number, senderAddress: string,
    settings: { slippageBps: number; maxPositionPct: number; dailyLossLimit: number; rebalanceThreshold: number },
    tokens: SwappableToken[],
  ): Promise<{ executed: number }> {
    const watchTokens = ((config.watchTokens as string) ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const maxBuyAmount = (config.maxBuyAmount as number) ?? 1;
    const slippageBps = (config.slippageBps as number) ?? settings.slippageBps;
    const perTokenCap = (config.perTokenCapUsd as number) ?? maxBuyAmount;
    const minLiquidity = (config.minLiquidity as number) ?? 0;
    const maxImpact = (config.maxPriceImpactPct as number) ?? 5;
    const cooldown = (config.cooldownMinutes as number) ?? 0;

    if (watchTokens.length === 0) return { executed: 0 };

    const registry = DEXRegistry.getInstance();
    const freshTokens = await registry.getSwappableTokens();
    const db = DatabaseService.getInstance();

    const actions: RebalanceAction[] = [];

    for (const watchSymbol of watchTokens) {
      const token = freshTokens.find((t) => t.symbol.toUpperCase() === watchSymbol);
      if (!token) continue;

      const existingTrade = await db.prisma.trade.findFirst({
        where: { userId, walletId, tokenOut: token.symbol, status: "CONFIRMED" },
      });
      if (existingTrade && cooldown <= 0) continue;
      if (existingTrade && cooldown > 0) {
        const elapsed = (Date.now() - existingTrade.createdAt.getTime()) / 60000;
        if (elapsed < cooldown) continue;
      }

      const quote = await registry.getBestQuote("STX", token.symbol, 0.001).catch(() => null);
      if (!quote || quote.quote.amountOut <= 0) continue;
      if (quote.quote.priceImpact > maxImpact) continue;

      actions.push({
        tokenIn: "STX", tokenOut: token.symbol,
        amountIn: Math.min(perTokenCap, maxBuyAmount),
        direction: "BUY",
        reason: `Sniper: auto-buy ${token.symbol}`,
      });
    }

    return this.executeApprovedActions(actions, walletId, userId, senderAddress, slippageBps);
  }

  private async runCopy(
    config: Record<string, unknown>,
    userId: number, walletId: number, senderAddress: string,
    settings: { slippageBps: number; maxPositionPct: number; dailyLossLimit: number; rebalanceThreshold: number },
    tokens: SwappableToken[],
  ): Promise<{ executed: number }> {
    const targetAddress = (config.targetAddress as string) ?? "";
    const maxPerTrade = (config.maxPerTrade as number) ?? 10;
    const maxCopies = (config.maxCopiesPerCycle as number) ?? 3;
    const copyRatio = (config.copyRatio as number) ?? 1;
    const delaySec = (config.delaySeconds as number) ?? 0;

    if (!targetAddress) return { executed: 0 };

    try {
      const stacksApi = ConfigManager.getInstance().config.STACKS_API_URL;
      const txs = await axios.get(`${stacksApi}/extended/v1/address/${targetAddress}/transactions`, {
        params: { limit: 10 },
        timeout: 10_000,
      }).catch(() => ({ data: { results: [] } }));

      const results = (txs.data?.results ?? []) as Array<{
        tx_id: string; tx_type: string; tx_status: string; block_time: number;
        stx_transfers?: Array<{ amount: string; recipient: string }>;
        ft_transfers?: Array<{ amount: string; asset_identifier: string; recipient: string }>;
      }>;

      const db = DatabaseService.getInstance();
      const actions: RebalanceAction[] = [];

      for (const tx of results) {
        if (tx.tx_type !== "contract_call" || tx.tx_status !== "success") continue;
        const existing = await db.prisma.trade.findFirst({ where: { userId, walletId, txId: tx.tx_id } });
        if (existing) continue;
        const ageMs = Date.now() - (tx.block_time ?? 0) * 1000;
        if (ageMs > 3600_000) continue;

        // Decode swap from transfers
        let tokenIn = "STX";
        let tokenOut = "sUSDT";
        let amount = Math.min(maxPerTrade, 5);
        let direction: "BUY" | "SELL" = "BUY";

        const stxOut = (tx.stx_transfers ?? []).filter((t: any) => t.recipient !== targetAddress);
        if (stxOut.length > 0) {
          amount = Math.min(Number(stxOut[0]!.amount) / 1e6 * copyRatio, maxPerTrade);
          tokenIn = "STX";
          direction = "BUY";
        }

        const ftIn = (tx.ft_transfers ?? []).filter((t: any) => t.recipient === targetAddress);
        if (ftIn.length > 0) {
          const matched = tokens.find((tok) => {
            const assetId = ((ftIn[0] as any)?.asset_identifier as string) ?? "";
            return tok.contractId.toLowerCase().includes((assetId.split("::")[0] ?? "").toLowerCase());
          });
          if (matched) {
            tokenOut = matched.symbol;
            direction = "BUY";
          }
        }

        const ftOut = (tx.ft_transfers ?? []).filter((t: any) => t.recipient !== targetAddress);
        if (ftOut.length > 0) {
          const matched = tokens.find((tok) => {
            const assetId = ((ftOut[0] as any)?.asset_identifier as string) ?? "";
            return tok.contractId.toLowerCase().includes((assetId.split("::")[0] ?? "").toLowerCase());
          });
          if (matched) {
            tokenIn = matched.symbol;
            direction = "SELL";
            amount = Math.min(Number(ftOut[0]!.amount) / 1e6 * copyRatio, maxPerTrade);
          }
        }

        if (delaySec > 0) await new Promise(r => setTimeout(r, delaySec * 1000));

        actions.push({ tokenIn, tokenOut, amountIn: amount, direction, reason: `Copy: ${targetAddress.slice(0, 8)}... tx ${tx.tx_id.slice(0, 8)}` });
        if (actions.length >= maxCopies) break;
      }

      return this.executeApprovedActions(actions, walletId, userId, senderAddress, settings.slippageBps);
    } catch {
      return { executed: 0 };
    }
  }

  // ════════════════════ NEW STRATEGIES ════════════════════

  private async runMomentum(
    config: Record<string, unknown>,
    userId: number, walletId: number, address: string,
    settings: { slippageBps: number; maxPositionPct: number; dailyLossLimit: number; rebalanceThreshold: number },
    tokens: SwappableToken[],
  ): Promise<{ executed: number }> {
    const lookback = (config.lookbackPeriods as number) ?? 20;
    const threshold = (config.momentumThresholdPct as number) ?? 2;
    const positionSize = (config.positionSizeUsd as number) ?? 10;
    const tokenUniverse = ((config.tokenUniverse as string) ?? "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    const exitThreshold = (config.exitThresholdPct as number) ?? -1;

    const ph = PriceHistoryService.getInstance();
    const available = tokenUniverse.length > 0
      ? tokens.filter(t => tokenUniverse.includes(t.symbol.toUpperCase()))
      : tokens.slice(0, 10);

    const actions: RebalanceAction[] = [];
    const db = DatabaseService.getInstance();

    for (const token of available) {
      const momentum = await ph.computeMomentum(token.symbol, lookback);
      const existing = await db.prisma.trade.findFirst({
        where: { userId, walletId, tokenOut: token.symbol, status: "CONFIRMED" },
      });

      if (momentum > threshold && !existing) {
        actions.push({
          tokenIn: "STX", tokenOut: token.symbol, amountIn: positionSize, direction: "BUY",
          reason: `Momentum: ${token.symbol} +${momentum.toFixed(1)}%`,
        });
      } else if (momentum < exitThreshold && existing) {
        actions.push({
          tokenIn: token.symbol, tokenOut: "STX", amountIn: Math.min(positionSize, existing.amountIn), direction: "SELL",
          reason: `Momentum exit: ${token.symbol} ${momentum.toFixed(1)}%`,
        });
      }
    }

    return this.executeApprovedActions(actions, walletId, userId, address, settings.slippageBps);
  }

  private async runMeanReversion(
    config: Record<string, unknown>,
    userId: number, walletId: number, address: string,
    settings: { slippageBps: number; maxPositionPct: number; dailyLossLimit: number; rebalanceThreshold: number },
  ): Promise<{ executed: number }> {
    const maPeriods = (config.maPeriods as number) ?? 20;
    const entryDeviation = (config.entryDeviationPct as number) ?? 5;
    const exitDeviation = (config.exitDeviationPct as number) ?? 1;
    const tokenPair = ((config.tokenPair as string) ?? "STX/sUSDT").split("/");
    const tokenIn = tokenPair[0] ?? "STX";
    const tokenOut = tokenPair[1] ?? "sUSDT";
    const positionSize = (config.positionSizeUsd as number) ?? 10;

    const ph = PriceHistoryService.getInstance();
    const price = await ph.getHistory(tokenOut, 1);
    if (price.length === 0) return { executed: 0 };

    const currentPrice = price[0]!;
    const ma = await ph.computeMovingAverage(tokenOut, maPeriods);
    if (ma === 0) return { executed: 0 };

    const deviation = ((currentPrice - ma) / ma) * 100;
    const db = DatabaseService.getInstance();
    const existing = await db.prisma.trade.findFirst({
      where: { userId, walletId, tokenOut, status: "CONFIRMED" },
    });

    const actions: RebalanceAction[] = [];

    if (deviation < -entryDeviation && !existing) {
      actions.push({
        tokenIn, tokenOut, amountIn: positionSize, direction: "BUY",
        reason: `Mean reversion buy: ${tokenOut} ${deviation.toFixed(1)}% below MA`,
      });
    } else if (deviation > exitDeviation && existing) {
      actions.push({
        tokenIn: tokenOut, tokenOut: tokenIn, amountIn: Math.min(positionSize, existing.amountIn), direction: "SELL",
        reason: `Mean reversion sell: ${tokenOut} ${deviation.toFixed(1)}% above MA`,
      });
    }

    return this.executeApprovedActions(actions, walletId, userId, address, settings.slippageBps);
  }

  private async runTWAP(
    config: Record<string, unknown>,
    userId: number, walletId: number, address: string,
    settings: { slippageBps: number; maxPositionPct: number; dailyLossLimit: number; rebalanceThreshold: number },
  ): Promise<{ executed: number }> {
    const tokenIn = (config.tokenIn as string) ?? "STX";
    const tokenOut = (config.tokenOut as string) ?? "sUSDT";
    const totalAmount = (config.totalAmount as number) ?? 1;
    const slices = (config.slices as number) ?? 10;
    const windowMinutes = (config.windowMinutes as number) ?? 60;
    const maxSlippage = (config.maxSlippageBps as number) ?? settings.slippageBps;

    const sliceSize = totalAmount / slices;
    const intervalMs = (windowMinutes * 60_000) / slices;

    const db = DatabaseService.getInstance();
    const lastSlice = await db.prisma.trade.findFirst({
      where: { userId, walletId, tokenOut, status: "CONFIRMED", direction: "BUY" },
      orderBy: { createdAt: "desc" },
    });

    if (lastSlice) {
      const elapsed = Date.now() - lastSlice.createdAt.getTime();
      if (elapsed < intervalMs) return { executed: 0 };
    }

    // Check total cap
    const completed = await db.prisma.trade.findMany({
      where: { userId, walletId, tokenOut, status: "CONFIRMED", direction: "BUY" },
    });
    const totalCompleted = completed.reduce((s, t) => s + t.amountIn, 0);
    if (totalCompleted >= totalAmount) return { executed: 0 };

    const remaining = totalAmount - totalCompleted;
    const thisSlice = Math.min(sliceSize, remaining);

    const action: RebalanceAction = {
      tokenIn, tokenOut, amountIn: thisSlice, direction: "BUY",
      reason: `TWAP slice: ${tokenIn}→${tokenOut} ${thisSlice.toFixed(4)}`,
    };

    return this.executeApprovedActions([action], walletId, userId, address, maxSlippage);
  }

  private async runStopLossTP(
    config: Record<string, unknown>,
    userId: number, walletId: number, address: string,
    settings: { slippageBps: number; maxPositionPct: number; dailyLossLimit: number; rebalanceThreshold: number },
    balances: TokenBalance[],
  ): Promise<{ executed: number }> {
    const token = ((config.token as string) ?? "").toUpperCase();
    const tpPct = (config.takeProfitPct as number) ?? 10;
    const slPct = (config.stopLossPct as number) ?? 5;
    const trailingSl = (config.trailingStopPct as number) ?? 0;

    if (!token) return { executed: 0 };

    const balance = balances.find(b => b.symbol.toUpperCase() === token);
    if (!balance || balance.balance <= 0) return { executed: 0 };

    const currentPrice = balance.usdValue / balance.balance;
    const db = DatabaseService.getInstance();

    // Get entry price from the last BUY trade for this token
    const entryTrade = await db.prisma.trade.findFirst({
      where: { userId, walletId, tokenOut: token, status: "CONFIRMED", direction: "BUY" },
      orderBy: { confirmedAt: "desc" },
    });
    if (!entryTrade || !entryTrade.confirmedAt) return { executed: 0 };

    // Compute entry price: amountIn (STX) / amountOut (token)
    const entryPrice = entryTrade.amountIn / Math.max(entryTrade.amountOut, 0.0001);
    const changePct = ((currentPrice - entryPrice) / entryPrice) * 100;

    const actions: RebalanceAction[] = [];

    if (changePct >= tpPct || changePct <= -slPct) {
      actions.push({
        tokenIn: token, tokenOut: "STX", amountIn: balance.balance, direction: "SELL",
        reason: `${changePct >= 0 ? "Take profit" : "Stop loss"}: ${token} ${changePct.toFixed(1)}%`,
      });
    }

    // Trailing stop
    if (trailingSl > 0 && changePct > 0) {
      const ph = PriceHistoryService.getInstance();
      const high = await ph.computeHigh(token, 50);
      if (high > 0) {
        const highChange = ((currentPrice - high) / high) * 100;
        if (highChange <= -trailingSl) {
          actions.push({
            tokenIn: token, tokenOut: "STX", amountIn: balance.balance, direction: "SELL",
            reason: `Trailing stop: ${token} -${Math.abs(highChange).toFixed(1)}% from high`,
          });
        }
      }
    }

    return this.executeApprovedActions(actions, walletId, userId, address, settings.slippageBps);
  }

  private async runRotational(
    config: Record<string, unknown>,
    userId: number, walletId: number, address: string,
    settings: { slippageBps: number; maxPositionPct: number; dailyLossLimit: number; rebalanceThreshold: number },
    tokens: SwappableToken[],
  ): Promise<{ executed: number }> {
    const topK = (config.topK as number) ?? 3;
    const rebalanceHours = (config.rebalancePeriodHours as number) ?? 24;
    const positionSize = (config.positionSizeUsd as number) ?? 10;
    const tokenUniverse = ((config.tokenUniverse as string) ?? "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

    const db = DatabaseService.getInstance();
    const lastRebalance = await db.prisma.trade.findFirst({
      where: { userId, walletId, status: "CONFIRMED", direction: "BUY" },
      orderBy: { createdAt: "desc" },
    });
    if (lastRebalance) {
      const elapsed = (Date.now() - lastRebalance.createdAt.getTime()) / 3600000;
      if (elapsed < rebalanceHours) return { executed: 0 };
    }

    const universe = tokenUniverse.length > 0
      ? tokens.filter(t => tokenUniverse.includes(t.symbol.toUpperCase()))
      : tokens.slice(0, 15);

    const ph = PriceHistoryService.getInstance();
    const scored: Array<{ symbol: string; momentum: number }> = [];

    for (const t of universe) {
      const momentum = await ph.computeMomentum(t.symbol, 20);
      scored.push({ symbol: t.symbol, momentum });
    }

    scored.sort((a, b) => b.momentum - a.momentum);
    const top = scored.slice(0, topK);

    // Sell everything not in top K
    const toSell = scored.slice(topK);
    const actions: RebalanceAction[] = [];

    for (const item of toSell) {
      const existing = await db.prisma.trade.findFirst({
        where: { userId, walletId, tokenOut: item.symbol, status: "CONFIRMED", direction: "BUY" },
      });
      if (existing) {
        actions.push({
          tokenIn: item.symbol, tokenOut: "STX", amountIn: Math.min(positionSize, existing.amountIn),
          direction: "SELL", reason: `Rotational sell: ${item.symbol}`,
        });
      }
    }

    // Buy top K
    for (const item of top) {
      const existing = await db.prisma.trade.findFirst({
        where: { userId, walletId, tokenOut: item.symbol, status: "CONFIRMED", direction: "BUY" },
      });
      if (!existing) {
        actions.push({
          tokenIn: "STX", tokenOut: item.symbol, amountIn: positionSize,
          direction: "BUY", reason: `Rotational buy: ${item.symbol} #${scored.indexOf(item) + 1}`,
        });
      }
    }

    return this.executeApprovedActions(actions, walletId, userId, address, settings.slippageBps);
  }

  private async runBreakout(
    config: Record<string, unknown>,
    userId: number, walletId: number, address: string,
    settings: { slippageBps: number; maxPositionPct: number; dailyLossLimit: number; rebalanceThreshold: number },
  ): Promise<{ executed: number }> {
    const lookback = (config.lookbackPeriods as number) ?? 20;
    const breakoutPct = (config.breakoutPct as number) ?? 3;
    const tokenPair = ((config.tokenPair as string) ?? "STX/sUSDT").split("/");
    const tokenIn = tokenPair[0] ?? "STX";
    const tokenOut = tokenPair[1] ?? "sUSDT";
    const positionSize = (config.positionSizeUsd as number) ?? 10;

    const ph = PriceHistoryService.getInstance();
    const prices = await ph.getHistory(tokenOut, 1);
    if (prices.length === 0) return { executed: 0 };
    const currentPrice = prices[0]!;

    const high = await ph.computeHigh(tokenOut, lookback);
    const low = await ph.computeLow(tokenOut, lookback);
    if (high === 0 || low === 0) return { executed: 0 };

    const breakoutUp = ((currentPrice - high) / high) * 100;
    const breakdownDown = ((low - currentPrice) / low) * 100;

    const db = DatabaseService.getInstance();
    const actions: RebalanceAction[] = [];

    if (breakoutUp > breakoutPct) {
      const existing = await db.prisma.trade.findFirst({
        where: { userId, walletId, tokenOut, status: "CONFIRMED", direction: "BUY" },
      });
      if (!existing) {
        actions.push({
          tokenIn, tokenOut, amountIn: positionSize, direction: "BUY",
          reason: `Breakout: ${tokenOut} +${breakoutUp.toFixed(1)}% above ${lookback}-period high`,
        });
      }
    }

    if (breakdownDown > breakoutPct) {
      const existing = await db.prisma.trade.findFirst({
        where: { userId, walletId, tokenOut, status: "CONFIRMED", direction: "BUY" },
      });
      if (existing) {
        actions.push({
          tokenIn: tokenOut, tokenOut: tokenIn, amountIn: Math.min(positionSize, existing.amountIn),
          direction: "SELL", reason: `Breakdown: ${tokenOut} -${breakdownDown.toFixed(1)}% below ${lookback}-period low`,
        });
      }
    }

    return this.executeApprovedActions(actions, walletId, userId, address, settings.slippageBps);
  }

  // ════════════════════ SHARED EXECUTION ════════════════════

  private async executeApprovedActions(
    actions: RebalanceAction[],
    walletId: number, userId: number, senderAddress: string,
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
        executed++;
      } else {
        await db.updateTradeStatus(trade.id, "FAILED", undefined, result.error);
      }
    }

    return { executed, attempted };
  }
}
