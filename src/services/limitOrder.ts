import { logger } from "../utils/logger.js";
import { DatabaseService } from "./db.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { PortfolioManager } from "./portfolio.js";
import { TransactionService } from "./transaction.js";
import { WebSocketManager } from "../api/websocket.js";
import type { SwappableToken } from "../types.js";

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

    const tokens = await registry.getSwappableTokens();
    const wallet = await db.findWalletById(data.walletId);
    if (!wallet) throw new Error(`Wallet ${data.walletId} not found`);

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

  async checkAndExecute(
    activeWallets: Array<{ id: number; userId: number; address: string }>,
    tokens: SwappableToken[]
  ): Promise<{ executed: number }> {
    const db = DatabaseService.getInstance();
    const registry = DEXRegistry.getInstance();
    const txService = TransactionService.getInstance();
    const wss = WebSocketManager.getInstance();

    const activeOrders = await db.prisma.limitOrder.findMany({
      where: { status: "ACTIVE" },
    });

    let executed = 0;
    const now = new Date();

    for (const order of activeOrders) {
      const wallet = activeWallets.find((w) => w.id === order.walletId);
      if (!wallet) continue;

      try {
        const targetToken = order.direction === "BUY" ? order.tokenOut : order.tokenIn;

        // Use DEXRegistry to get current price via a 1-unit quote
        const priceQuote = await registry.getBestQuote(order.tokenIn, "sUSDT", 1).catch(() => null);
        const currentPrice = priceQuote?.quote.amountOut ?? 0;

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

        const bestQuoteResult = await registry.getBestQuote(order.tokenIn, order.tokenOut, order.amountIn);
        if (!bestQuoteResult) {
          logger.warn("No route for limit order", { orderId: order.id });
          continue;
        }

        const { providerName, quote: est } = bestQuoteResult;
        const provider = registry.getProvider(providerName);
        if (!provider) continue;

        const minOut = est.amountOut * 0.99;
        const payload = await provider.buildSwapPayload(
          order.tokenIn, order.tokenOut, order.amountIn, minOut, wallet.address
        );

        if (!payload) {
          logger.warn("Failed to build payload for limit order", { orderId: order.id, providerName });
          continue;
        }

        const settings = await db.findTradeSettings(order.userId, "personal");
        const useGasless = settings?.useGasless ?? false;

        const result = await txService.execute(
          {
            tokenIn: order.tokenIn,
            tokenOut: order.tokenOut,
            amountIn: order.amountIn,
            direction: order.direction as "BUY" | "SELL",
            reason,
          },
          payload.contractAddress,
          payload.contractName,
          payload.functionName,
          payload.functionArgs,
          wallet.id,
          wallet.address,
          est.amountOut,
          useGasless,
          payload.postConditions
        );

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

          executed++;
        } else {
          logger.error("Limit order execution failed", {
            orderId: order.id,
            error: result.error,
          });
        }
      } catch (error) {
        logger.error("Limit order check failed", { orderId: order.id, error });
      }
    }

    return { executed };
  }
}
