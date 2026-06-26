import type { Request, Response, NextFunction } from "express";
import { LimitOrderService } from "../../services/limitOrder.js";
import { DatabaseService } from "../../services/db.js";
import { logger } from "../../utils/logger.js";
import { ValidationError, NotFoundError, InternalError } from "../errors.js";

export class LimitOrderController {
  static async getLimitOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const service = LimitOrderService.getInstance();
      const orders = await service.getActive(req.userId!);

      res.json({
        orders: orders.map((o) => ({
          id: o.id,
          walletId: o.walletId,
          tokenIn: o.tokenIn,
          tokenOut: o.tokenOut,
          direction: o.direction,
          targetPrice: o.targetPrice,
          amountIn: o.amountIn,
          status: o.status,
          forceAfter: o.forceAfter,
          expiresAt: o.expiresAt,
          createdAt: o.createdAt,
          filledAt: o.filledAt,
          txId: o.txId,
        })),
      });
    } catch (error) {
      logger.error("Failed to fetch limit orders", { error });
      next(new InternalError());
    }
  }

  static async createLimitOrder(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const db = DatabaseService.getInstance();
      const service = LimitOrderService.getInstance();
      const data = req.body as {
        walletIds?: number[];
        walletId?: number;
        tokenIn: string;
        tokenOut: string;
        direction: string;
        targetPrice: number;
        amountIn: number;
        forceAfter?: string;
        expiresAt?: string;
      };

      const walletIds = data.walletIds?.length ? data.walletIds : (data.walletId ? [data.walletId] : []);
      if (walletIds.length === 0) {
        return next(new ValidationError("walletIds or walletId is required"));
      }

      const orders = [];

      for (const wid of walletIds) {
        const wallet = await db.findWalletById(wid);
        if (!wallet || wallet.userId !== req.userId) continue;

        const order = await service.create({
          userId: req.userId!,
          walletId: wid,
          tokenIn: data.tokenIn,
          tokenOut: data.tokenOut,
          direction: data.direction,
          targetPrice: data.targetPrice,
          amountIn: data.amountIn,
          forceAfter: data.forceAfter ? new Date(data.forceAfter) : undefined,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
        });
        orders.push(order);
      }

      res.status(201).json({ orders });
    } catch (error) {
      logger.error("Failed to create limit order", { error });
      next(new InternalError());
    }
  }

  static async cancelLimitOrder(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const id = parseInt(String(req.params.id ?? ""), 10);
      if (isNaN(id)) return next(new ValidationError("Invalid order ID"));

      const db = DatabaseService.getInstance();
      const order = await db.prisma.limitOrder.findUnique({
        where: { id },
      });

      if (!order || order.userId !== req.userId) {
        return next(new NotFoundError("Limit order not found or access denied"));
      }

      const service = LimitOrderService.getInstance();
      await service.cancel(id);

      res.json({ ok: true });
    } catch (error) {
      logger.error("Failed to cancel limit order", { error });
      next(new InternalError());
    }
  }
}
