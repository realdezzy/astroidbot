import { logger } from "../utils/logger.js";
import { DatabaseService } from "./db.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { PortfolioManager } from "./portfolio.js";
import { WebSocketManager } from "../api/websocket.js";
import { NotificationService } from "./notificationService.js";
import type { SwappableToken } from "../types.js";
import { executeSwapPayload } from "./chains/executeSwap.js";
import { walletChainId, walletStableSymbol } from "./chains/walletChain.js";

export class LimitOrderService {
  private static instance: LimitOrderService;

  private constructor() {
  }

  static getInstance(): LimitOrderService {
    if (!LimitOrderService.instance) {
      LimitOrderService.instance = new LimitOrderService();
    }
    return LimitOrderService.instance;
  }

  async create(data: {
    userId: number;
    walletId: number;
    tokenIn: string;
    tokenOut: string;
    direction: string;
    targetPrice: number;
    amountIn: number;
    forceAfter?: Date;
    expiresAt?: Date;
  }) {
    const db = DatabaseService.getInstance();
    const registry = DEXRegistry.getInstance();

    const wallet = await db.findWalletById(data.walletId);
    if (!wallet) throw new Error(`Wallet ${data.walletId} not found`);

    const tokens = await registry.getSwappableTokens(false, walletChainId(wallet));
    const balances = await PortfolioManager.getInstance().fetchBalances(wallet.address, tokens, data.userId);
    const tokenBalanceObj = balances.find(b =>
      b.symbol.toUpperCase() === data.tokenIn.toUpperCase() || b.token === data.tokenIn
    );
    const tokenBalance = tokenBalanceObj?.balance ?? 0;

    const activeOrders = await db.prisma.limitOrder.findMany({
      where: { walletId: data.walletId, status: "ACTIVE" },
    });
    const pendingTrades = await db.prisma.trade.findMany({
      where: { walletId: data.walletId, status: { in: ["PENDING", "BROADCAST"] } },
    });

    const withheld = [
      ...activeOrders.filter(o => o.tokenIn.toUpperCase() === data.tokenIn.toUpperCase()),
      ...pendingTrades.filter(t => t.tokenIn.toUpperCase() === data.tokenIn.toUpperCase()),
    ].reduce((sum, r) => sum + r.amountIn, 0);

    if (tokenBalance - withheld < data.amountIn) {
      throw new Error(
        `Insufficient available balance for ${data.tokenIn}. ` +
        `Available: ${tokenBalance - withheld}, Required: ${data.amountIn}`
      );
    }

    // Validate a route exists before persisting
    const quote = await registry.getBestQuote(data.tokenIn, data.tokenOut, data.amountIn);
    if (!quote) {
      throw new Error(`No DEX route found for ${data.tokenIn} → ${data.tokenOut}`);
    }

    return db.prisma.limitOrder.create({ data });
  }

  async getActive(userId: number) {
    const db = DatabaseService.getInstance();
    return db.prisma.limitOrder.findMany({
      where: { userId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
    });
  }

  async cancel(orderId: number) {
    const db = DatabaseService.getInstance();
    return db.prisma.limitOrder.update({
      where: { id: orderId },
      data: { status: "CANCELLED" },
    });
  }

  private async handleLimitOrderSuccess(orderId: number): Promise<void> {
    const db = DatabaseService.getInstance();
    await db.prisma.limitOrder.update({
      where: { id: orderId },
      data: { failureCount: 0 },
    });
  }

  private async handleLimitOrderFailure(orderId: number, userId: number, errorMsg: string): Promise<void> {
    const db = DatabaseService.getInstance();
    const order = await db.prisma.limitOrder.findUnique({
      where: { id: orderId },
    });
    if (!order) return;

    const newFailureCount = order.failureCount + 1;
    if (newFailureCount >= 5) {
      await db.prisma.limitOrder.update({
        where: { id: orderId },
        data: { failureCount: newFailureCount, status: "SUSPENDED" },
      });

      await db.prisma.auditLog.create({
        data: {
          userId,
          action: "LIMIT_ORDER_AUTO_DISABLE",
          details: `Limit Order ${order.tokenIn}→${order.tokenOut} (ID: ${orderId}) suspended after 5 consecutive failures. Last error: ${errorMsg}`,
        },
      });

      await NotificationService.getInstance().send({
        userId,
        title: "Limit Order Suspended",
        message: `Your limit order to swap ${order.amountIn} ${order.tokenIn} to ${order.tokenOut} has been suspended due to 5 consecutive failures. Last error: ${errorMsg}`,
        type: "ERROR",
      });
    } else {
      await db.prisma.limitOrder.update({
        where: { id: orderId },
        data: { failureCount: newFailureCount },
      });
    }
  }

  async checkAndExecute(
    activeWallets: Array<{ id: number; userId: number; address: string; chainFamily?: string; chain?: string }>,
    _tokens: SwappableToken[]
  ): Promise<{ executed: number }> {
    const db = DatabaseService.getInstance();
    const registry = DEXRegistry.getInstance();
    const wss = WebSocketManager.getInstance();

    const activeOrders = await db.prisma.limitOrder.findMany({
      where: { status: "ACTIVE" },
    });

    let executed = 0;
    const now = new Date();

    for (const order of activeOrders) {
      const wallet = activeWallets.find((w) => w.id === order.walletId);
      if (!wallet) continue;

      const chainId = walletChainId(wallet);

      try {
        // targetPrice is denominated in the wallet's chain's USD stablecoin —
        // "USDCx" on Stacks, "USDC" on Base. Previously hardcoded to the Stacks
        // symbol, which no Base provider can route, so every Base order read a
        // current price of 0 and could only ever fire via forceAfter.
        const stableSymbol = walletStableSymbol(wallet);

        // Current price via a 1-unit quote. A stablecoin prices at 1 against
        // itself; quoting it against itself has no route.
        let currentPrice: number;
        if (order.tokenIn.toUpperCase() === stableSymbol.toUpperCase()) {
          currentPrice = 1;
        } else {
          const priceQuote = await registry
            .getBestQuote(order.tokenIn, stableSymbol, 1, chainId)
            .catch(() => null);
          currentPrice = priceQuote?.quote.amountOut ?? 0;
        }

        let shouldExecute = false;
        let reason = "";

        if (order.forceAfter && now >= order.forceAfter) {
          shouldExecute = true;
          reason = "force-executed";
        } else if (order.direction === "BUY" && currentPrice > 0 && currentPrice <= order.targetPrice) {
          shouldExecute = true;
          reason = `price ${currentPrice} <= target ${order.targetPrice}`;
        } else if (order.direction === "SELL" && currentPrice > 0 && currentPrice >= order.targetPrice) {
          shouldExecute = true;
          reason = `price ${currentPrice} >= target ${order.targetPrice}`;
        }

        if (order.expiresAt && now >= order.expiresAt && !shouldExecute) {
          await db.prisma.limitOrder.update({
            where: { id: order.id },
            data: { status: "EXPIRED" },
          });
          continue;
        }

        if (!shouldExecute) continue;

        try {
          const bestQuoteResult = await registry.getBestQuote(order.tokenIn, order.tokenOut, order.amountIn, chainId);
          if (!bestQuoteResult) {
            throw new Error("No route found for limit order");
          }

          const { providerName, quote: est } = bestQuoteResult;
          const provider = registry.getProvider(providerName);
          if (!provider) {
            throw new Error(`DEX provider ${providerName} not found`);
          }

          const minOut = est.amountOut * 0.99;
          const payload = await provider.buildSwapPayload(
            order.tokenIn, order.tokenOut, order.amountIn, minOut, wallet.address
          );

          if (!payload) {
            throw new Error("Failed to build transaction payload");
          }

          const settings = await db.findTradeSettings(order.userId, "personal");
          const useGasless = settings?.useGasless ?? false;

          const result = await executeSwapPayload(payload, {
            action: {
              tokenIn: order.tokenIn,
              tokenOut: order.tokenOut,
              amountIn: order.amountIn,
              direction: order.direction as "BUY" | "SELL",
              reason,
            },
            walletId: wallet.id,
            senderAddress: wallet.address,
            maxOutbound: est.amountOut,
            useGasless,
            chainId,
          });

          if ("txId" in result) {
            const trade = await db.createTrade({
              walletId: wallet.id,
              userId: order.userId,
              direction: order.direction,
              tokenIn: order.tokenIn,
              tokenOut: order.tokenOut,
              amountIn: order.amountIn,
              amountOut: est.amountOut,
              feeAmount: est.feeAmount,
              feeBps: est.feeBps,
            });

            await db.updateTradeStatus(trade.id, "BROADCAST", result.txId);
            await db.prisma.limitOrder.update({
              where: { id: order.id },
              data: { status: "PENDING_FILL", txId: result.txId },
            });

            wss.broadcastTradeEvent(order.userId, "trade_broadcast", {
              tradeId: trade.id,
              txId: result.txId,
              direction: order.direction,
              tokenIn: order.tokenIn,
              tokenOut: order.tokenOut,
              amountIn: order.amountIn,
              amountOut: est.amountOut,
              feeAmount: est.feeAmount,
              feeBps: est.feeBps,
            });

            await this.handleLimitOrderSuccess(order.id);
            executed++;
          } else {
            throw new Error(result.error || "Transaction broadcast failed");
          }
        } catch (execErr) {
          const errorMsg = execErr instanceof Error ? execErr.message : String(execErr);
          logger.error("Limit order execution failed", {
            orderId: order.id,
            error: errorMsg,
          });
          await this.handleLimitOrderFailure(order.id, order.userId, errorMsg);
        }
      } catch (error) {
        logger.error("Limit order check failed", { orderId: order.id, error });
      }
    }

    return { executed };
  }
}
