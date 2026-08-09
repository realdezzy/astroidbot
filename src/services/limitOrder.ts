import { logger } from "../utils/logger.js";
import { DatabaseService } from "./db.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { PortfolioManager } from "./portfolio.js";
import { WebSocketManager } from "../api/websocket.js";
import { NotificationService } from "./notificationService.js";
import type { SwappableToken } from "../types.js";
import { executeSwapPayload } from "./chains/executeSwap.js";
import { walletChainId, walletStableSymbol } from "./chains/walletChain.js";
import { resolveTradeSettings } from "./tradeSettings.js";
import { resolveMarketDataProvider } from "./marketData/index.js";
import type { ChainId } from "../types/chain.js";

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

    const chainId = walletChainId(wallet);
    const tokens = await registry.getSwappableTokens(false, chainId);

    // Does this pair exist on this chain at all? Asked *before* the balance
    // check, because the balance check answers the wrong question when it
    // doesn't: a Celo wallet asked for STX reports "insufficient balance for
    // STX, available 0", which reads as "add funds" when the real answer is
    // "STX does not exist on Celo". Cheap, too — this is a list lookup, while
    // the balance check is a chain round trip.
    const known = (symbol: string): boolean =>
      tokens.some(
        (t) => t.symbol.toUpperCase() === symbol.toUpperCase() || t.contractId === symbol
      );

    // Skipped when the chain's token list is empty, which means the provider
    // is unreachable rather than that nothing exists — refusing every order on
    // an upstream hiccup would be worse than letting the route check decide.
    if (tokens.length > 0) {
      const missing = [data.tokenIn, data.tokenOut].filter((symbol) => !known(symbol));
      if (missing.length > 0) {
        throw new Error(
          `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not available on ` +
          `${chainId}. This wallet can only trade tokens on that chain.`
        );
      }
    }

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

    // Validate a route exists before persisting — on *this wallet's* chain.
    //
    // Unscoped, this asked every registered provider, so a Base wallet's
    // STX→USDCx order passed because a Stacks router answered. The order was
    // then written, could never route at execution time, and the price trigger
    // read 0 — so it sat there until `forceAfter` fired it into a failure.
    // Naming the chain in the error matters too: "no route" on its own reads
    // as a liquidity problem rather than a wrong-network one.
    const quote = await registry.getBestQuote(data.tokenIn, data.tokenOut, data.amountIn, chainId);
    if (!quote) {
      throw new Error(
        `No DEX route found for ${data.tokenIn} → ${data.tokenOut} on ${chainId}`
      );
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

  /**
   * A token's price in USD on one chain.
   *
   * `targetPrice` is a dollar figure, so this has to be one too. A direct
   * quote against the chain's stablecoin is the obvious way to get it, and it
   * returns 0 whenever that symbol can't be routed — which has happened twice
   * now for different reasons: Base, when the symbol was hardcoded to Stacks'
   * "USDCx", and Robinhood, when the descriptor named a real token that had no
   * pools. Both times the visible symptom was orders sitting untriggered until
   * `forceAfter` fired them.
   *
   * The market-data layer is the one that owns USD anchoring, including the
   * fallback that prices a chain's native asset from *another* chain when
   * there is no local path to a dollar. Ask it first; fall back to the direct
   * quote only when it has nothing, which covers a chain the index hasn't
   * warmed up on yet.
   */
  private async priceInUsd(
    tokenIn: string,
    wallet: { chainFamily?: string; chain?: string },
    chainId: ChainId
  ): Promise<number> {
    const stableSymbol = walletStableSymbol(wallet);

    // A stablecoin is worth a dollar; quoting it against itself has no route.
    if (tokenIn.toUpperCase() === stableSymbol.toUpperCase()) return 1;

    try {
      const provider = resolveMarketDataProvider();
      if (provider.supportsChain(chainId)) {
        const data = await provider.getMarketData(chainId, [tokenIn.toLowerCase()]);
        const priceUsd = data.get(tokenIn.toLowerCase())?.priceUsd;
        if (priceUsd != null && priceUsd > 0) return priceUsd;
      }
    } catch (error) {
      logger.debug("[limitOrder] market data price lookup failed, falling back to a quote", {
        chainId,
        tokenIn,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const priceQuote = await DEXRegistry.getInstance()
      .getBestQuote(tokenIn, stableSymbol, 1, chainId)
      .catch(() => null);
    return priceQuote?.quote.amountOut ?? 0;
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
        const currentPrice = await this.priceInUsd(order.tokenIn, wallet, chainId);

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

          const settings = await resolveTradeSettings(order.userId, "personal", chainId);
          const useGasless = settings.useGasless;

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
