import type { Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { DatabaseService } from "../../services/db.js";
import { logger } from "../../utils/logger.js";
import { ValidationError, NotFoundError, InternalError } from "../errors.js";
import { DEXRegistry } from "../../services/dex/dexRegistry.js";
import { safeValidateStrategyConfig } from "../../services/strategy/configValidation.js";

export class StrategyController {
  static async getStrategies(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const db = DatabaseService.getInstance();
      const agentIdRaw = req.query.agentId;
      const where: Record<string, unknown> = { userId: req.userId! };
      if (agentIdRaw !== undefined) {
        const agentId = parseInt(String(agentIdRaw), 10);
        if (!isNaN(agentId)) where.agentId = agentId;
      }
      const strategies = await db.prisma.tradingStrategy.findMany({
        where,
        orderBy: { createdAt: "desc" },
      });
      res.json({ strategies });
    } catch (error) {
      logger.error("Failed to fetch strategies", { error });
      next(new InternalError());
    }
  }

  static async createStrategy(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { agentId, type, config, walletIds, isActive } = req.body as {
        agentId: number;
        type: string;
        config: Record<string, unknown>;
        walletIds: number[];
        isActive?: boolean;
      };

      const db = DatabaseService.getInstance();

      const agent = await db.prisma.tradeAgent.findUnique({ where: { id: agentId } });
      if (!agent || agent.userId !== req.userId) {
        return next(new ValidationError("Invalid agent"));
      }

      const wallets = await db.prisma.wallet.findMany({
        where: { id: { in: walletIds }, userId: req.userId! },
      });
      if (wallets.length !== walletIds.length) {
        return next(new ValidationError("One or more wallet IDs are invalid or not owned by you"));
      }

      const validatedConfig = safeValidateStrategyConfig(type, { ...config, walletIds });
      if (!validatedConfig.success) {
        return next(new ValidationError("Invalid strategy config", validatedConfig.error.flatten()));
      }

      const strategy = await db.prisma.tradingStrategy.create({
        data: {
          userId: req.userId!,
          agentId,
          type,
          config: validatedConfig.data as Prisma.InputJsonValue,
          isActive: isActive ?? true,
        },
      });

      res.status(201).json(strategy);
    } catch (error) {
      logger.error("Failed to create strategy", { error });
      next(new InternalError());
    }
  }

  static async updateStrategy(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const id = parseInt(String(req.params.id ?? ""), 10);
      if (isNaN(id)) return next(new ValidationError("Invalid strategy ID"));

      const { isActive, config, walletIds } = req.body as {
        isActive?: boolean;
        config?: Record<string, unknown>;
        walletIds?: number[];
      };

      const db = DatabaseService.getInstance();
      const existing = await db.prisma.tradingStrategy.findUnique({ where: { id } });
      if (!existing || existing.userId !== req.userId) {
        return next(new NotFoundError("Strategy"));
      }

      if (walletIds !== undefined) {
        const wallets = await db.prisma.wallet.findMany({
          where: { id: { in: walletIds }, userId: req.userId! },
        });
        if (wallets.length !== walletIds.length) {
          return next(new ValidationError("One or more wallet IDs are invalid or not owned by you"));
        }
      }

      const data: Record<string, unknown> = {};
      if (isActive !== undefined) data.isActive = isActive;
      if (config || walletIds !== undefined) {
        const nextConfig = { ...(existing.config as Record<string, unknown>), ...config, ...(walletIds !== undefined ? { walletIds } : {}) };
        const validatedConfig = safeValidateStrategyConfig(existing.type, nextConfig);
        if (!validatedConfig.success) {
          return next(new ValidationError("Invalid strategy config", validatedConfig.error.flatten()));
        }
        data.config = validatedConfig.data as Prisma.InputJsonValue;
      }

      const updated = await db.prisma.tradingStrategy.update({ where: { id }, data });
      res.json(updated);
    } catch (error) {
      logger.error("Failed to update strategy", { error });
      next(new InternalError());
    }
  }

  static async deleteStrategy(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const id = parseInt(String(req.params.id ?? ""), 10);
      if (isNaN(id)) return next(new ValidationError("Invalid strategy ID"));

      const db = DatabaseService.getInstance();
      const existing = await db.prisma.tradingStrategy.findUnique({ where: { id } });
      if (!existing || existing.userId !== req.userId) {
        return next(new NotFoundError("Strategy"));
      }

      await db.prisma.tradingStrategy.delete({ where: { id } });
      res.json({ ok: true });
    } catch (error) {
      logger.error("Failed to delete strategy", { error });
      next(new InternalError());
    }
  }

  static async getStrategyDetail(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const id = parseInt(String(req.params.id ?? ""), 10);
      if (isNaN(id)) return next(new ValidationError("Invalid strategy ID"));

      const db = DatabaseService.getInstance();
      const strategy = await db.prisma.tradingStrategy.findUnique({ where: { id } });
      if (!strategy || strategy.userId !== req.userId) {
        return next(new NotFoundError("Strategy"));
      }

      const config = strategy.config as Record<string, unknown> || {};
      const walletIds = Array.isArray(config.walletIds) ? config.walletIds : [];

      const trades = await db.prisma.trade.findMany({
        where: {
          userId: req.userId!,
          walletId: { in: walletIds },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });

      let pnl = 0;
      let stxPrice = 2.0;
      try {
        stxPrice = await DEXRegistry.getInstance().getTokenPrice("STX") || 2.0;
      } catch {
        // ignore price fetch failure, fallback to 2.0
      }

      trades.forEach((t) => {
        if (t.status === "CONFIRMED") {
          const amountInUsd = t.amountInUsd ?? (t.tokenIn === "STX" ? t.amountIn * stxPrice : t.amountIn);
          const amountOutUsd = t.amountOutUsd ?? (t.tokenOut === "STX" ? t.amountOut * stxPrice : t.amountOut);
          pnl += t.direction === "BUY" ? -amountInUsd : amountOutUsd;
        }
      });

      res.json({
        strategy: {
          id: strategy.id,
          type: strategy.type,
          config,
          isActive: strategy.isActive,
          createdAt: strategy.createdAt,
          updatedAt: strategy.updatedAt,
        },
        trades: trades.map((t) => ({
          id: t.id,
          direction: t.direction,
          tokenIn: t.tokenIn,
          tokenOut: t.tokenOut,
          amountIn: t.amountIn,
          amountOut: t.amountOut,
          feeAmount: t.feeAmount,
          feeBps: t.feeBps,
          txId: t.txId,
          status: t.status,
          createdAt: t.createdAt,
          confirmedAt: t.confirmedAt,
        })),
        pnl,
        totalTrades: trades.length,
      });
    } catch (error) {
      logger.error("Failed to fetch strategy details", { error });
      next(new InternalError());
    }
  }
}
