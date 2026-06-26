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
import { WebSocketManager } from "../api/websocket.js";
import type { RebalanceAction, TokenBalance, SwappableToken } from "../types.js";

interface ExecutedTrade {
  walletId: number;
  userId: number;
  action: RebalanceAction;
  txId: string;
}

export class StrategyEngine {
  private static instance: StrategyEngine;

  private constructor() {
  }

  static getInstance(): StrategyEngine {
    if (!StrategyEngine.instance) {
      StrategyEngine.instance = new StrategyEngine();
    }
    return StrategyEngine.instance;
  }

  async runCycle(): Promise<{ actionsExecuted: number; totalPnl: number }> {
    const db = DatabaseService.getInstance();
    const registry = DEXRegistry.getInstance();
    const wss = WebSocketManager.getInstance();

    const tokens = await registry.getSwappableTokens();
    if (tokens.length === 0) {
      logger.warn("No swappable tokens available");
      return { actionsExecuted: 0, totalPnl: 0 };
    }

    // Only run strategies that are NOT owned by an agent (agents trigger their own strategies)
    const activeStrategies = await db.prisma.tradingStrategy.findMany({
      where: { isActive: true, agentId: null },
    });

    // Pre-load active user IDs to filter inactive users
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

      const strategyWallets = await db.prisma.wallet.findMany({
        where: { id: { in: strategyWalletIds }, userId: strategy.userId },
      });

      const settings = await db.findTradeSettings(strategy.userId, "personal");
      if (!settings) continue;

      for (const wallet of strategyWallets) {
        const balances = await PortfolioManager.getInstance().fetchBalances(
          wallet.address, tokens, strategy.userId
        );
        if (balances.length === 0) continue;

        try {
          const result = await this.executeStrategy(
            strategy.type,
            strategy.config as Record<string, unknown>,
            strategy.userId,
            wallet.id,
            wallet.address,
            balances,
            tokens,
            settings,
          );
          actionsExecuted += result.executed;
        } catch (error) {
          logger.error(`Strategy ${strategy.type} failed`, { userId: strategy.userId, walletId: wallet.id, error });
        }
      }

      totalPnl += await RiskManager.getInstance().getDailyPnl(strategy.userId);
    }

    return { actionsExecuted, totalPnl };
  }

  /**
   * Run a specific list of strategies (used by agents).
   * Returns the number of strategies that completed and total actions executed.
   */
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

      const wallets = await db.prisma.wallet.findMany({
        where: { id: { in: walletIds }, userId: strategy.userId },
      });
      const settings = await db.findTradeSettings(strategy.userId, "personal");
      if (!settings) continue;

      let ranAtLeastOne = false;
      for (const wallet of wallets) {
        const balances = await PortfolioManager.getInstance().fetchBalances(
          wallet.address, tokens, strategy.userId,
        );
        if (balances.length === 0) continue;

        try {
          const result = await this.executeStrategy(
            strategy.type, config, strategy.userId,
            wallet.id, wallet.address, balances, tokens, settings,
          );
          actionsExecuted += result.executed;
          ranAtLeastOne = true;
        } catch (error) {
          logger.error(`Agent strategy ${strategy.type} failed`, {
            userId: strategy.userId, walletId: wallet.id, error,
          });
        }
      }

      if (ranAtLeastOne) strategiesRun += 1;
    }

    return { strategies: strategiesRun, actions: actionsExecuted };
  }

  private async executeStrategy(
    type: string,
    config: Record<string, unknown>,
    userId: number,
    walletId: number,
    address: string,
    balances: TokenBalance[],
    tokens: SwappableToken[],
    settings: { slippageBps: number; maxPositionPct: number; dailyLossLimit: number; rebalanceThreshold: number },
  ): Promise<{ executed: number }> {
    switch (type) {
      case "portfolio_rebalance":
        return this.runPortfolioRebalance(userId, walletId, address, balances, tokens, settings);
      case "grid":
        return this.runGrid(config, userId, walletId, address, balances, settings);
      case "dca":
        return this.runDCA(config, userId, walletId, address, settings);
      case "sniper":
        return this.runSniper(config, userId, walletId, address, settings, tokens);
      case "copy":
        return this.runCopy(config, userId, walletId, address, settings);
      default:
        return { executed: 0 };
    }
  }

  private async runPortfolioRebalance(
    userId: number, walletId: number, address: string,
    balances: TokenBalance[], tokens: SwappableToken[],
    settings: { slippageBps: number; maxPositionPct: number; dailyLossLimit: number; rebalanceThreshold: number },
  ): Promise<{ executed: number }> {
    const ai = AIOrchestrator.getInstance();
    const portfolio = PortfolioManager.getInstance();
    const risk = RiskManager.getInstance();

    const tokenSymbols = balances.map((b) => b.symbol);
    const priceData: Record<string, number[]> = {};
    for (const b of balances) {
      priceData[b.symbol] = [b.usdValue / Math.max(b.balance, 0.001)];
    }

    const sentiment = await ai.analyzeSentiment(userId, tokenSymbols, priceData);
    const targets = await ai.generatePortfolioTargets(userId, balances, sentiment);
    const actions = portfolio.computeRebalanceActions(balances, targets, settings.rebalanceThreshold);

    const { approved } = await risk.evaluateActions(userId, actions, balances, {
      slippageBps: settings.slippageBps,
      maxPositionPct: settings.maxPositionPct,
      dailyLossLimit: settings.dailyLossLimit,
    });

    return this.executeApprovedActions(approved, walletId, userId, address, settings.slippageBps);
  }

  private async runGrid(
    config: Record<string, unknown>,
    userId: number, walletId: number,
    address: string,
    balances: TokenBalance[],
    settings: { slippageBps: number; maxPositionPct: number; dailyLossLimit: number; rebalanceThreshold: number },
  ): Promise<{ executed: number }> {
    const mm = MarketMakerService.getInstance();
    const actions = await mm.tick(userId, walletId, balances);
    if (actions.length === 0) return { executed: 0 };

    return this.executeApprovedActions(actions, walletId, userId, address, settings.slippageBps);
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

    // Check if enough time has passed since last DCA
    const db = DatabaseService.getInstance();
    const lastTrade = await db.prisma.trade.findFirst({
      where: { userId, walletId, status: "CONFIRMED" },
      orderBy: { createdAt: "desc" },
    });

    if (lastTrade) {
      const elapsed = (Date.now() - lastTrade.createdAt.getTime()) / 60000;
      if (elapsed < intervalMinutes) return { executed: 0 };
    }

    const action: RebalanceAction = {
      tokenIn, tokenOut, amountIn: amount, direction: "BUY",
      reason: `DCA strategy: ${tokenIn} → ${tokenOut} every ${intervalMinutes}min`,
    };

    return this.executeApprovedActions([action], walletId, userId, address, settings.slippageBps);
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

    if (watchTokens.length === 0) return { executed: 0 };

    const registry = DEXRegistry.getInstance();
    const freshTokens = await registry.getSwappableTokens();

    const actions: RebalanceAction[] = [];

    for (const watchSymbol of watchTokens) {
      const token = freshTokens.find((t) => t.symbol.toUpperCase() === watchSymbol);
      if (!token) continue;

      const db = DatabaseService.getInstance();
      const existingTrade = await db.prisma.trade.findFirst({
        where: { userId, walletId, tokenOut: token.symbol, status: "CONFIRMED" },
      });

      if (existingTrade) continue;

      const hasRoute = await registry.getBestQuote("STX", token.symbol, 0.001).catch(() => null);
      if (!hasRoute) continue;

      actions.push({
        tokenIn: "STX", tokenOut: token.symbol,
        amountIn: Math.min(maxBuyAmount, 10),
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
  ): Promise<{ executed: number }> {
    const targetAddress = (config.targetAddress as string) ?? "";
    const maxPerTrade = (config.maxPerTrade as number) ?? 10;
    const minLiquidity = (config.minLiquidity as number) ?? 1000;

    if (!targetAddress) return { executed: 0 };

    try {
      const stacksApi = ConfigManager.getInstance().config.STACKS_API_URL;
      const txs = await axios.get(`${stacksApi}/extended/v1/address/${targetAddress}/transactions`, {
        params: { limit: 5 },
        timeout: 10_000,
      }).catch(() => ({ data: { results: [] } }));

      const results = (txs.data?.results ?? []) as Array<{
        tx_id: string; tx_type: string; contract_call?: { contract_id: string; function_name: string };
        tx_status: string; block_time: number;
        stx_transfers?: Array<{ amount: string; sender: string; recipient: string }>;
        ft_transfers?: Array<{ amount: string; sender: string; recipient: string; asset_identifier: string }>;
      }>;

      const db = DatabaseService.getInstance();
      const registry = DEXRegistry.getInstance();
      const tokens = await registry.getSwappableTokens();
      const actions: RebalanceAction[] = [];

      for (const tx of results) {
        if (tx.tx_type !== "contract_call") continue;
        if (tx.tx_status !== "success") continue;
        if (!tx.contract_call) continue;

        // Check if we already copied this transaction
        const existing = await db.prisma.trade.findFirst({
          where: { userId, walletId, txId: tx.tx_id },
        });
        if (existing) continue;

        // Check if this is a recent tx (<1 hour)
        const ageMs = Date.now() - (tx.block_time ?? 0) * 1000;
        if (ageMs > 3600_000) continue;

        // Parse transfers to dynamically decode swap components
        const stxTransfers = tx.stx_transfers || [];
        const ftTransfers = tx.ft_transfers || [];

        let tokenInSymbol = "";
        let tokenOutSymbol = "";
        let rawAmountIn = 0;

        // Check what target address sent (Token In)
        const sentStx = stxTransfers.find((t) => t.sender === targetAddress);
        if (sentStx) {
          tokenInSymbol = "STX";
          rawAmountIn = parseFloat(sentStx.amount) / 1_000_000; // STX has 6 decimals
        } else {
          const sentFt = ftTransfers.find((t) => t.sender === targetAddress);
          if (sentFt) {
            const matchedToken = tokens.find(
              (tok) =>
                tok.contractId === sentFt.asset_identifier ||
                sentFt.asset_identifier.includes(tok.contractId) ||
                sentFt.asset_identifier.toLowerCase().includes(tok.symbol.toLowerCase())
            );
            if (matchedToken) {
              tokenInSymbol = matchedToken.symbol;
              rawAmountIn = parseFloat(sentFt.amount) / Math.pow(10, matchedToken.decimals);
            }
          }
        }

        // Check what target address received (Token Out)
        const recStx = stxTransfers.find((t) => t.recipient === targetAddress);
        if (recStx) {
          tokenOutSymbol = "STX";
        } else {
          const recFt = ftTransfers.find((t) => t.recipient === targetAddress);
          if (recFt) {
            const matchedToken = tokens.find(
              (tok) =>
                tok.contractId === recFt.asset_identifier ||
                recFt.asset_identifier.includes(tok.contractId) ||
                recFt.asset_identifier.toLowerCase().includes(tok.symbol.toLowerCase())
            );
            if (matchedToken) {
              tokenOutSymbol = matchedToken.symbol;
            }
          }
        }

        if (tokenInSymbol && tokenOutSymbol && tokenInSymbol !== tokenOutSymbol && rawAmountIn > 0) {
          actions.push({
            tokenIn: tokenInSymbol,
            tokenOut: tokenOutSymbol,
            amountIn: Math.min(rawAmountIn, maxPerTrade),
            direction: tokenInSymbol === "STX" ? "BUY" : "SELL",
            reason: `Copy trade: mirroring ${targetAddress.slice(0, 8)}... swapped ${tokenInSymbol} -> ${tokenOutSymbol} tx ${tx.tx_id.slice(0, 8)}`,
          });
        } else {
          // Fallback to STX -> sUSDT if parsing failed to preserve compatibility
          actions.push({
            tokenIn: "STX", tokenOut: "sUSDT",
            amountIn: Math.min(maxPerTrade, 5),
            direction: "BUY",
            reason: `Copy trade: mirroring ${targetAddress.slice(0, 8)}... tx ${tx.tx_id.slice(0, 8)}`,
          });
        }

        if (actions.length >= 3) break; // Max 3 copies per cycle
      }

      return this.executeApprovedActions(actions, walletId, userId, senderAddress, settings.slippageBps);
    } catch {
      return { executed: 0 };
    }
  }

  private async executeApprovedActions(
    actions: RebalanceAction[],
    walletId: number, userId: number, senderAddress: string,
    slippageBps: number,
  ): Promise<{ executed: number }> {
    let executed = 0;
    const registry = DEXRegistry.getInstance();
    const txService = TransactionService.getInstance();
    const db = DatabaseService.getInstance();
    const wss = WebSocketManager.getInstance();

    for (const action of actions) {
      const bestQuoteResult = await registry.getBestQuote(action.tokenIn, action.tokenOut, action.amountIn);
      if (!bestQuoteResult) continue;

      const { providerName, quote: est } = bestQuoteResult;
      const provider = registry.getProvider(providerName);
      if (!provider) continue;

      if (est.priceImpact / 10000 > slippageBps / 10000) continue;

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
        action, payload.contractAddress, payload.contractName,
        payload.functionName, payload.functionArgs,
        walletId, senderAddress, est.amountOut,
        false, payload.postConditions
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

    return { executed };
  }
}
