import type { Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { DatabaseService } from "../../services/db.js";
import { logger } from "../../utils/logger.js";
import { ValidationError, NotFoundError, InternalError } from "../errors.js";
import { DEXRegistry } from "../../services/dex/dexRegistry.js";
import { safeValidateStrategyConfig } from "../../services/strategy/configValidation.js";
import { walletChainId, explorerTxUrlFor } from "../../services/chains/walletChain.js";

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
        include: { wallet: { select: { chain: true, chainFamily: true } } },
      });

      // Legs without a USD value recorded at execution are priced live, on
      // the trade's own chain. This used to look up STX alone, unscoped, and
      // count every other unrecorded leg's raw token amount as dollars — one
      // ETH booked as one dollar. An unpriceable leg stays null, never a guess:
      // the old `getTokenPrice("STX") || 2.0` reported a made-up STX price as P&L.
      const registry = DEXRegistry.getInstance();
      const legKey = (chain: string, symbol: string): string => `${chain}:${symbol}`;
      const unrecordedLegs = new Map<string, { chain: string; symbol: string }>();
      for (const t of trades) {
        if (t.status !== "CONFIRMED") continue;
        const chain = t.chain ?? walletChainId(t.wallet);
        if (t.amountInUsd === null) unrecordedLegs.set(legKey(chain, t.tokenIn), { chain, symbol: t.tokenIn });
        if (t.amountOutUsd === null) unrecordedLegs.set(legKey(chain, t.tokenOut), { chain, symbol: t.tokenOut });
      }
      const livePrices = new Map<string, number | null>();
      await Promise.all(
        [...unrecordedLegs].map(async ([key, { chain, symbol }]) => {
          const price = await registry.getTokenPrice(symbol, chain).catch(() => null);
          livePrices.set(key, price !== null && price > 0 ? price : null);
        }),
      );

      // Trades whose USD value was recorded at execution are exact. The rest
      // need a live price, and where that price is a guess the trade is
      // excluded from the total rather than valued at a made-up number — a
      // P&L short a few legs is recoverable, one quietly wrong is not.
      let pnl = 0;
      let unpricedTrades = 0;

      trades.forEach((t) => {
        if (t.status !== "CONFIRMED") return;

        const chain = t.chain ?? walletChainId(t.wallet);
        const legUsd = (recorded: number | null, symbol: string, amount: number): number | null => {
          if (recorded !== null) return recorded;
          const price = livePrices.get(legKey(chain, symbol)) ?? null;
          return price !== null ? amount * price : null;
        };

        const amountInUsd = legUsd(t.amountInUsd, t.tokenIn, t.amountIn);
        const amountOutUsd = legUsd(t.amountOutUsd, t.tokenOut, t.amountOut);

        const leg = t.direction === "BUY" ? amountInUsd : amountOutUsd;
        if (leg === null) {
          unpricedTrades++;
          return;
        }

        pnl += t.direction === "BUY" ? -leg : leg;
      });

      if (unpricedTrades > 0) {
        logger.warn("[strategy] P&L excludes trades with an unpriceable leg", {
          strategyId: strategy.id,
          unpricedTrades,
        });
      }

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
          chain: t.chain ?? walletChainId(t.wallet),
          // Resolved server-side: this modal used to build a Hiro link for
          // every strategy trade regardless of the chain it ran on.
          explorerUrl: explorerTxUrlFor(t.chain ?? walletChainId(t.wallet), t.txId),
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
