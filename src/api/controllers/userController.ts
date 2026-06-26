import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { DatabaseService } from "../../services/db.js";
import { DEXRegistry } from "../../services/dex/dexRegistry.js";
import type { DEXQuote } from "../../types/dexProvider.js";
import { PortfolioManager } from "../../services/portfolio.js";
import { TransactionService } from "../../services/transaction.js";
import { KMSService } from "../../services/kms.js";
import { logger } from "../../utils/logger.js";
import { encrypt } from "../../utils/crypto.js";
import { generateWalletKeypair, deriveAddressFromPrivateKey } from "../../services/wallet.js";
import {
  NotFoundError,
  InternalError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  UnauthorizedError,
} from "../errors.js";

export class UserController {
  static async getMe(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const db = DatabaseService.getInstance();
      const user = await db.findUserById(req.userId!);

      if (!user) {
        return next(new NotFoundError("User"));
      }

      res.json({
        id: user.id,
        telegramId: user.telegramId ? String(user.telegramId) : null,
        username: user.username,
        email: user.email,
        emailVerified: user.emailVerified,
        referralCode: user.referralCode,
        points: user.points,
        isActive: user.isActive,
        createdAt: user.createdAt,
      });
    } catch (error) {
      logger.error("Failed to fetch user", { error });
      next(new InternalError());
    }
  }

  static async getWallets(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const db = DatabaseService.getInstance();
      const wallets = await db.findWalletsByUserId(req.userId!);

      const registry = DEXRegistry.getInstance();
      const tokens = await registry.getSwappableTokens();
      const pm = PortfolioManager.getInstance();

      const stxPrice = await DEXRegistry.getInstance().getTokenPrice("STX") || 2.0;

      const updatedWallets = await Promise.all(
        wallets.map(async (w) => {
          try {
            const balances = await pm.fetchBalances(w.address, tokens, req.userId!);
            const stxBal = balances.find((b) => b.symbol === "STX")?.balance ?? 0;
            const totalWalletUsd = balances.reduce((sum, b) => sum + (b.usdValue ?? 0), 0);
            await db.updateWalletBalance(w.id, stxBal);
            return {
              id: w.id,
              address: w.address,
              name: w.name,
              balance: stxBal,
              balanceUsd: totalWalletUsd,
              createdAt: w.createdAt,
            };
          } catch (err) {
            logger.error(`Failed to update balance for wallet ${w.address}`, { err });
            return {
              id: w.id,
              address: w.address,
              name: w.name,
              balance: w.balance,
              balanceUsd: w.balance * stxPrice,
              createdAt: w.createdAt,
            };
          }
        })
      );

      res.json(updatedWallets);
    } catch (error) {
      logger.error("Failed to fetch wallets", { error });
      next(new InternalError());
    }
  }

  static async getTrades(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page, limit, status, direction } = (req as Request & { validatedQuery?: Record<string, unknown> }).validatedQuery as {
        page: number;
        limit: number;
        status?: string;
        direction?: string;
      };

      const db = DatabaseService.getInstance();

      const where: Record<string, unknown> = {
        userId: req.userId!,
      };

      if (status) where.status = status;
      if (direction) where.direction = direction;

      const [trades, total] = await Promise.all([
        db.prisma.trade.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
          include: {
            wallet: { select: { name: true, address: true } },
          },
        }),
        db.prisma.trade.count({ where }),
      ]);

      const items = trades.map((t) => ({
        id: t.id,
        walletName: t.wallet.name,
        walletAddress: t.wallet.address,
        direction: t.direction,
        tokenIn: t.tokenIn,
        tokenOut: t.tokenOut,
        amountIn: t.amountIn,
        amountOut: t.amountOut,
        amountInUsd: t.amountInUsd,
        amountOutUsd: t.amountOutUsd,
        txId: t.txId,
        status: t.status,
        errorMessage: t.errorMessage,
        createdAt: t.createdAt,
        confirmedAt: t.confirmedAt,
      }));

      res.json({ items, total, page, limit });
    } catch (error) {
      logger.error("Failed to fetch trades", { error });
      next(new InternalError());
    }
  }

  static async getSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const db = DatabaseService.getInstance();
      const context =
        (req.query.context as string) ?? "personal";

      const settings = await db.findTradeSettings(req.userId!, context);

      res.json(
        settings ?? {
          context,
          chain: "stacks:mainnet",
          slippageBps: 100,
          maxPositionPct: 25.0,
          dailyLossLimit: 5.0,
          rebalanceThreshold: 2.0,
        }
      );
    } catch (error) {
      logger.error("Failed to fetch settings", { error });
      next(new InternalError());
    }
  }

  static async updateSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const db = DatabaseService.getInstance();
      const data = req.body as {
        context?: string;
        chain?: string;
        slippageBps?: number;
        maxPositionPct?: number;
        dailyLossLimit?: number;
        rebalanceThreshold?: number;
      };

      const settings = await db.upsertTradeSettings({
        userId: req.userId!,
        context: data.context ?? "personal",
        chain: data.chain,
        slippageBps: data.slippageBps,
        maxPositionPct: data.maxPositionPct,
        dailyLossLimit: data.dailyLossLimit,
        rebalanceThreshold: data.rebalanceThreshold,
      });

      res.json(settings);
    } catch (error) {
      logger.error("Failed to update settings", { error });
      next(new InternalError());
    }
  }

  static async getRecommendations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const db = DatabaseService.getInstance();
      const limit = Math.min(
        parseInt(req.query.limit as string, 10) || 10,
        50
      );

      const recommendations = await db.prisma.aIRecommendation.findMany({
        where: { userId: req.userId! },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          context: true,
          modelProvider: true,
          modelName: true,
          recommendation: true,
          actedUpon: true,
          createdAt: true,
        },
      });

      res.json(recommendations);
    } catch (error) {
      logger.error("Failed to fetch recommendations", { error });
      next(new InternalError());
    }
  }

  static async generateWallet(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name } = req.body as { name?: string };
      const db = DatabaseService.getInstance();

      const existing = await db.findWalletsByUserId(req.userId!);
      const walletName = name?.trim() || `Wallet ${existing.length + 1}`;

      const { privateKeyHex, address } = generateWalletKeypair();
      const encryptedKey = encrypt(privateKeyHex);

      const wallet = await db.createWallet({
        userId: req.userId!,
        address,
        name: walletName,
        encryptedKey,
      });

      logger.info("Wallet generated", { userId: req.userId, address });

      res.status(201).json({
        id: wallet.id,
        address: wallet.address,
        name: wallet.name,
        balance: wallet.balance,
        balanceUsd: 0,
        createdAt: wallet.createdAt,
      });
    } catch (error) {
      logger.error("Failed to generate wallet", { error: error instanceof Error ? error.message : String(error) });
      next(new InternalError());
    }
  }

  static async importWallet(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { privateKey, name } = req.body as { privateKey: string; name?: string };
      const db = DatabaseService.getInstance();

      let address: string;
      try {
        address = deriveAddressFromPrivateKey(privateKey.trim());
      } catch {
        return next(new ValidationError("Invalid Stacks private key"));
      }

      const existing = await db.findWalletByAddress(address);
      if (existing) {
        return next(new ConflictError("A wallet with this address already exists"));
      }

      const allWallets = await db.findWalletsByUserId(req.userId!);
      const walletName = name?.trim() || `Wallet ${allWallets.length + 1}`;

      const encryptedKey = encrypt(privateKey.trim());
      const wallet = await db.createWallet({
        userId: req.userId!,
        address,
        name: walletName,
        encryptedKey,
      });

      logger.info("Wallet imported", { userId: req.userId, address });

      const registry = DEXRegistry.getInstance();
      const tokens = await registry.getSwappableTokens();
      const balances = await PortfolioManager.getInstance().fetchBalances(wallet.address, tokens, req.userId!);
      const stxBal = balances.find((b) => b.symbol === "STX")?.balance ?? 0;

      const stxPrice = await DEXRegistry.getInstance().getTokenPrice("STX") || 2.0;

      await db.updateWalletBalance(wallet.id, stxBal);

      res.status(201).json({
        id: wallet.id,
        address: wallet.address,
        name: wallet.name,
        balance: stxBal,
        balanceUsd: stxBal * stxPrice,
        createdAt: wallet.createdAt,
      });
    } catch (error) {
      logger.error("Failed to import wallet", { error });
      next(new InternalError());
    }
  }

  static async deleteWallet(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const walletId = parseInt(String(req.params.id ?? "0"), 10);
      if (!walletId) return next(new ValidationError("Invalid wallet id"));

      const db = DatabaseService.getInstance();
      const wallet = await db.findWalletById(walletId);

      if (!wallet) return next(new NotFoundError("Wallet"));
      if (wallet.userId !== req.userId) return next(new ForbiddenError());

      const all = await db.findWalletsByUserId(req.userId!);
      if (all.length <= 1) {
        return next(new ValidationError("Cannot delete your only wallet"));
      }

      await db.prisma.wallet.delete({ where: { id: walletId } });
      logger.info("Wallet deleted", { userId: req.userId, walletId });

      res.json({ ok: true });
    } catch (error) {
      logger.error("Failed to delete wallet", { error });
      next(new InternalError());
    }
  }

  static async revealPrivateKey(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const walletId = parseInt(String(req.params.id ?? "0"), 10);
      if (!walletId) return next(new ValidationError("Invalid wallet id"));

      const db = DatabaseService.getInstance();
      const user = await db.findUserById(req.userId!);
      if (!user) return next(new NotFoundError("User"));

      if (!user.passwordHash) {
        return next(new ValidationError("Link an email and password before revealing private keys"));
      }

      const { password } = req.body as { password: string };
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return next(new UnauthorizedError("Incorrect password"));
      }

      const wallet = await db.findWalletById(walletId);
      if (!wallet) return next(new NotFoundError("Wallet"));
      if (wallet.userId !== req.userId) return next(new ForbiddenError());

      const privateKey = await KMSService.getInstance().decryptPrivateKey(wallet.encryptedKey);

      await db.createAuditLog({
        userId: req.userId!,
        action: "WALLET_REVEAL",
        details: `Private key revealed for wallet ID ${walletId} (${wallet.address.slice(0, 8)}...)`,
        ipAddress: (req.headers["x-forwarded-for"] as string) || req.ip || undefined,
      });

      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");

      res.json({ privateKey });
    } catch (error) {
      logger.error("Failed to reveal private key", { error });
      next(new InternalError());
    }
  }

  static async getWalletBalances(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const walletId = parseInt(String(req.params.id ?? "0"), 10);
      if (!walletId) return next(new ValidationError("Invalid wallet id"));

      const db = DatabaseService.getInstance();
      const wallet = await db.findWalletById(walletId);

      if (!wallet) return next(new NotFoundError("Wallet"));
      if (wallet.userId !== req.userId) return next(new ForbiddenError());

      const registry = DEXRegistry.getInstance();
      const tokens = await registry.getSwappableTokens();
      const balances = await PortfolioManager.getInstance().fetchBalances(wallet.address, tokens, req.userId!);

      res.json(balances);
    } catch (error) {
      logger.error("Failed to fetch wallet balances", { error });
      next(new InternalError());
    }
  }

  static async transferWallet(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const walletId = parseInt(String(req.params.id ?? "0"), 10);
      if (!walletId) return next(new ValidationError("Invalid wallet id"));

      const { toAddress, amount, token } = req.body as { toAddress: string; amount: number; token: string };

      const db = DatabaseService.getInstance();
      const wallet = await db.findWalletById(walletId);

      if (!wallet) return next(new NotFoundError("Wallet"));
      if (wallet.userId !== req.userId) return next(new ForbiddenError());

      const registry = DEXRegistry.getInstance();
      const tokens = await registry.getSwappableTokens();
      const tokenObj = tokens.find(t => t.contractId === token || t.symbol === token);
      const decimals = tokenObj ? tokenObj.decimals : 6;

      const txService = TransactionService.getInstance();
      const result = await txService.transfer(
        wallet.id,
        wallet.address,
        toAddress,
        amount,
        token === "STX" ? "STX" : (tokenObj ? tokenObj.contractId : token),
        decimals
      );

      if ("txId" in result) {
        return res.json({ ok: true, txId: result.txId });
      }

      res.status(400).json({ error: result.error });
    } catch (error) {
      logger.error("Wallet transfer failed", { error });
      next(new InternalError());
    }
  }

  static async executeTrade(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { walletId, tokenIn, tokenOut, amountIn, direction, minAmountOut, dex } = req.body as {
        walletId: number; tokenIn: string; tokenOut: string; amountIn: number; direction: string; minAmountOut?: number; dex?: string;
      };

      const db = DatabaseService.getInstance();
      let selectedWalletId = walletId;
      if (!selectedWalletId || selectedWalletId === 0) {
        const wallets = await db.findWalletsByUserId(req.userId!);
        if (wallets.length === 0) {
          return next(new ValidationError("No wallet found for this user"));
        }
        selectedWalletId = wallets[0]!.id;
      }

      const wallet = await db.findWalletById(selectedWalletId);
      if (!wallet || wallet.userId !== req.userId!) {
        return next(new NotFoundError("Wallet"));
      }

      const registry = DEXRegistry.getInstance();
      const tokens = await registry.getSwappableTokens();
      const balances = await PortfolioManager.getInstance().fetchBalances(wallet.address, tokens, req.userId!);

      const tokenBalanceObj = balances.find(b => b.symbol.toUpperCase() === tokenIn.toUpperCase() || b.token === tokenIn);
      const tokenBalance = tokenBalanceObj ? tokenBalanceObj.balance : 0;

      const activeOrders = await db.prisma.limitOrder.findMany({
        where: { walletId, status: "ACTIVE" }
      });
      const pendingTrades = await db.prisma.trade.findMany({
        where: { walletId, status: { in: ["PENDING", "BROADCAST"] } }
      });

      const withheldOrders = activeOrders
        .filter(o => o.tokenIn.toUpperCase() === tokenIn.toUpperCase() || o.tokenIn === tokenIn)
        .reduce((sum, o) => sum + o.amountIn, 0);

      const withheldTrades = pendingTrades
        .filter(t => t.tokenIn.toUpperCase() === tokenIn.toUpperCase() || t.tokenIn === tokenIn)
        .reduce((sum, t) => sum + t.amountIn, 0);

      const totalWithheld = withheldOrders + withheldTrades;
      const availableBalance = tokenBalance - totalWithheld;

      if (availableBalance < amountIn) {
        return res.status(400).json({ error: `Insufficient available balance for ${tokenIn}. Available: ${availableBalance}, Required: ${amountIn} (accounting for pending trades/orders)` });
      }

      let selectedProviderName: string;
      let est: DEXQuote;

      if (dex) {
        const provider = registry.getProvider(dex);
        if (!provider) {
          return res.status(400).json({ error: `Selected DEX provider '${dex}' is not registered` });
        }
        const hasRoute = await provider.hasRoute(tokenIn, tokenOut);
        if (!hasRoute) {
          return res.status(400).json({ error: `Selected DEX provider '${dex}' does not support route ${tokenIn} -> ${tokenOut}` });
        }
        est = await provider.getQuote(tokenIn, tokenOut, amountIn);
        if (est.amountOut <= 0) {
          return res.status(400).json({ error: `Selected DEX provider '${dex}' returned a zero-output quote` });
        }
        selectedProviderName = provider.name;
      } else {
        const bestQuoteResult = await registry.getBestQuote(tokenIn, tokenOut, amountIn);
        if (!bestQuoteResult) {
          return res.status(400).json({ error: "No swap route found for this pair on any DEX" });
        }
        selectedProviderName = bestQuoteResult.providerName;
        est = bestQuoteResult.quote;
      }

      const provider = registry.getProvider(selectedProviderName);
      if (!provider) {
        return res.status(500).json({ error: "Selected DEX provider not found" });
      }

      const userMinOut = minAmountOut ?? est.amountOut * 0.99;
      const payload = await provider.buildSwapPayload(tokenIn, tokenOut, amountIn, userMinOut, wallet.address);

      if (!payload) {
        return res.status(400).json({ error: `Failed to build swap payload for ${selectedProviderName}` });
      }

      const txService = TransactionService.getInstance();
      const action = { tokenIn, tokenOut, amountIn, direction: direction as "BUY" | "SELL", reason: "Manual trade via web" };
      const result = await txService.execute(
        action, payload.contractAddress, payload.contractName,
        payload.functionName, payload.functionArgs,
        wallet.id, wallet.address, est.amountOut,
        false, payload.postConditions
      );

      if ("txId" in result) {
        const trade = await db.createTrade({
          walletId: wallet.id, userId: req.userId!,
          direction, tokenIn, tokenOut,
          amountIn, amountOut: est.amountOut,
          feeAmount: est.feeAmount, feeBps: est.feeBps,
        });
        await db.updateTradeStatus(trade.id, "BROADCAST", result.txId);
        return res.json({ ok: true, tradeId: trade.id, txId: result.txId, estimate: est, dex: selectedProviderName });
      }

      res.status(500).json({ error: result.error });
    } catch (error) {
      logger.error("Trade execution failed", { error });
      next(new InternalError());
    }
  }

  static async getTradeQuote(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { tokenIn, tokenOut, amountIn } = req.query as { tokenIn?: string; tokenOut?: string; amountIn?: string };
      if (!tokenIn || !tokenOut || !amountIn) {
        return res.status(400).json({ error: "tokenIn, tokenOut, and amountIn are required" });
      }

      const amt = parseFloat(amountIn);
      if (isNaN(amt) || amt <= 0) {
        return res.status(400).json({ error: "amountIn must be a positive number" });
      }

      const registry = DEXRegistry.getInstance();
      const quotes = await registry.getAllQuotes(tokenIn, tokenOut, amt);
      if (quotes.length === 0) {
        return res.status(400).json({ error: "No swap route found for this pair on any DEX" });
      }

      const best = quotes[0]!;

      res.json({
        tokenIn, tokenOut, amountIn: amt,
        amountOut: best.quote.amountOut,
        priceImpact: best.quote.priceImpact,
        feeBps: best.quote.feeBps,
        feeAmount: best.quote.feeAmount,
        dex: best.providerName,
        quotes: quotes.map((q) => ({
          dex: q.providerName,
          amountOut: q.quote.amountOut,
          priceImpact: q.quote.priceImpact,
          feeBps: q.quote.feeBps,
          feeAmount: q.quote.feeAmount,
          isBest: q.isBest,
        })),
      });
    } catch (error) {
      logger.error("Quote fetch failed", { error });
      next(new InternalError());
    }
  }

  static async getAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const db = DatabaseService.getInstance();
      const userId = req.userId!;

      const trades = await db.prisma.trade.findMany({
        where: { userId, status: "CONFIRMED" },
        orderBy: { createdAt: "asc" },
      });

      const dailyStats: Record<string, { pnl: number; volume: number; buyCount: number; sellCount: number }> = {};

      const now = new Date();
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(now.getDate() - i);
        const dateStr = d.toISOString().split("T")[0] as string;
        dailyStats[dateStr] = { pnl: 0, volume: 0, buyCount: 0, sellCount: 0 };
      }

      const stxPrice = await DEXRegistry.getInstance().getTokenPrice("STX") || 2.0;

      trades.forEach((t) => {
        const dateStr = new Date(t.createdAt).toISOString().split("T")[0] as string;

        const amountInUsd = t.amountInUsd ?? (t.tokenIn === "STX" ? t.amountIn * stxPrice : t.amountIn);
        const amountOutUsd = t.amountOutUsd ?? (t.tokenOut === "STX" ? t.amountOut * stxPrice : t.amountOut);

        const tradePnl = t.direction === "BUY" ? -amountInUsd : amountOutUsd;
        const tradeVolume = amountInUsd;

        if (!dailyStats[dateStr]) {
          dailyStats[dateStr] = { pnl: 0, volume: 0, buyCount: 0, sellCount: 0 };
        }

        const stat = dailyStats[dateStr]!;
        stat.volume += tradeVolume;
        if (t.direction === "BUY") {
          stat.buyCount += 1;
        } else {
          stat.sellCount += 1;
        }
        stat.pnl += tradePnl;
      });

      let runningPnl = 0;
      const sortedDates = Object.keys(dailyStats).sort();
      const data = sortedDates.map((date) => {
        const day = dailyStats[date]!;
        runningPnl += day.pnl;
        return {
          date,
          pnl: runningPnl,
          volume: day.volume,
          buys: day.buyCount,
          sells: day.sellCount,
        };
      });

      const totalVolume = trades.reduce((sum, t) => {
        const amountInUsd = t.amountInUsd ?? (t.tokenIn === "STX" ? t.amountIn * stxPrice : t.amountIn);
        return sum + amountInUsd;
      }, 0);

      const totalProfit = trades.reduce((sum, t) => {
        const amountInUsd = t.amountInUsd ?? (t.tokenIn === "STX" ? t.amountIn * stxPrice : t.amountIn);
        const amountOutUsd = t.amountOutUsd ?? (t.tokenOut === "STX" ? t.amountOut * stxPrice : t.amountOut);
        if (t.direction === "BUY") return sum - amountInUsd;
        return sum + amountOutUsd;
      }, 0);

      res.json({
        summary: {
          totalTrades: trades.length,
          totalVolume,
          totalProfit,
        },
        chartData: data,
      });
    } catch (error) {
      logger.error("Failed to generate analytics", { error });
      next(new InternalError());
    }
  }
}
