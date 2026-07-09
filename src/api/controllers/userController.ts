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
import { CandleService, CandleData } from "../../services/quant/candleService.js";
import {
  NotFoundError,
  InternalError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  UnauthorizedError,
  AppError,
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
              balances,
              isDefault: w.isDefault,
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
              balances: [
                {
                  token: "STX",
                  symbol: "STX",
                  balance: w.balance,
                  usdValue: w.balance * stxPrice,
                },
              ],
              isDefault: w.isDefault,
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
          useGasless: false,
          gaslessFeeToken: "USDC",
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
        useGasless?: boolean;
        gaslessFeeToken?: string;
      };

      const settings = await db.upsertTradeSettings({
        userId: req.userId!,
        context: data.context ?? "personal",
        chain: data.chain,
        slippageBps: data.slippageBps,
        maxPositionPct: data.maxPositionPct,
        dailyLossLimit: data.dailyLossLimit,
        rebalanceThreshold: data.rebalanceThreshold,
        useGasless: data.useGasless,
        gaslessFeeToken: data.gaslessFeeToken,
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
        isDefault: wallet.isDefault,
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
        isDefault: wallet.isDefault,
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

      if (wallet.isDefault) {
        const remaining = await db.prisma.wallet.findMany({
          where: { userId: req.userId! },
          orderBy: { createdAt: "asc" },
        });
        if (remaining.length > 0) {
          await db.prisma.wallet.update({
            where: { id: remaining[0]!.id },
            data: { isDefault: true },
          });
          logger.info("Promoted wallet to default after deletion", { userId: req.userId, walletId: remaining[0]!.id });
        }
      }

      res.json({ ok: true });
    } catch (error) {
      logger.error("Failed to delete wallet", { error });
      next(new InternalError());
    }
  }

  static async setDefaultWallet(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const walletId = parseInt(String(req.params.id ?? "0"), 10);
      if (!walletId) return next(new ValidationError("Invalid wallet id"));

      const db = DatabaseService.getInstance();
      const wallet = await db.findWalletById(walletId);

      if (!wallet) return next(new NotFoundError("Wallet"));
      if (wallet.userId !== req.userId!) return next(new ForbiddenError());

      await db.setDefaultWallet(req.userId!, walletId);
      logger.info("Wallet set as default", { userId: req.userId, walletId });

      res.json({ ok: true });
    } catch (error) {
      logger.error("Failed to set default wallet", { error });
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
      const balances = await PortfolioManager.getInstance().fetchBalances(wallet.address, tokens, req.userId!, true);

      res.json(balances);
    } catch (error: any) {
      logger.error("Failed to fetch wallet balances", { error });
      next(new AppError(error?.message || "Failed to fetch wallet balances", 502, "BAD_GATEWAY"));
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
        const defaultWallet = await db.findDefaultWalletByUserId(req.userId!);
        if (!defaultWallet) {
          return next(new ValidationError("No wallet found for this user"));
        }
        selectedWalletId = defaultWallet.id;
      }

      const wallet = await db.findWalletById(selectedWalletId);
      if (!wallet || wallet.userId !== req.userId!) {
        return next(new NotFoundError("Wallet"));
      }

      const registry = DEXRegistry.getInstance();
      const tokens = await registry.getSwappableTokens();
      const balances = await PortfolioManager.getInstance().fetchBalances(wallet.address, tokens, req.userId!, true);

      const tokenBalanceObj = balances.find(b => b.symbol.toUpperCase() === tokenIn.toUpperCase() || b.token === tokenIn);
      const tokenBalance = tokenBalanceObj ? tokenBalanceObj.balance : 0;

      const activeOrders = await db.prisma.limitOrder.findMany({
        where: { walletId: selectedWalletId, status: "ACTIVE" }
      });
      const pendingTrades = await db.prisma.trade.findMany({
        where: { walletId: selectedWalletId, status: { in: ["PENDING", "BROADCAST"] } }
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

      const settings = await db.findTradeSettings(req.userId!, "personal");
      const useGasless = settings?.useGasless ?? false;

      const txService = TransactionService.getInstance();
      const action = { tokenIn, tokenOut, amountIn, direction: direction as "BUY" | "SELL", reason: "Manual trade via web" };
      const result = await txService.execute(
        action, payload.contractAddress, payload.contractName,
        payload.functionName, payload.functionArgs,
        wallet.id, wallet.address, est.amountOut,
        useGasless, payload.postConditions
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
    } catch (error: any) {
      logger.error("Quote fetch failed", { error });
      next(new AppError(error?.message || "Quote fetch failed", 502, "BAD_GATEWAY"));
    }
  }

  static async getAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const db = DatabaseService.getInstance();
      const userId = req.userId!;
      const walletIdQuery = req.query.walletId;

      const now = new Date();
      let timeframe = (req.query.timeframe as string || "7d").toLowerCase();
      if (!["1d", "7d", "30d", "all"].includes(timeframe)) {
        timeframe = "7d";
      }

      let candleTf = "1d";
      let intervalMs = 24 * 60 * 60 * 1000;
      let limit = 7;

      if (timeframe === "1d") {
        candleTf = "1h";
        intervalMs = 60 * 60 * 1000;
        limit = 24;
      } else if (timeframe === "7d") {
        candleTf = "1d";
        intervalMs = 24 * 60 * 60 * 1000;
        limit = 7;
      } else if (timeframe === "30d") {
        candleTf = "1d";
        intervalMs = 24 * 60 * 60 * 1000;
        limit = 30;
      } else if (timeframe === "all") {
        candleTf = "1d";
        intervalMs = 24 * 60 * 60 * 1000;
        const oldestTrade = await db.prisma.trade.findFirst({
          where: { userId, status: "CONFIRMED" },
          orderBy: { createdAt: "asc" },
        });
        if (oldestTrade) {
          const daysSinceFirstTrade = Math.ceil((now.getTime() - oldestTrade.createdAt.getTime()) / intervalMs);
          limit = Math.min(365, Math.max(1, daysSinceFirstTrade));
        } else {
          limit = 30;
        }
      }

      const candleService = CandleService.getInstance();
      const periods: Date[] = [];
      const nowMs = now.getTime();
      for (let i = limit - 1; i >= 0; i--) {
        periods.push(candleService.getPeriodStart(nowMs - i * intervalMs, candleTf));
      }
      const startDate = periods[0]!;

      const where: any = { userId, status: "CONFIRMED", createdAt: { gte: startDate } };
      if (walletIdQuery) {
        where.walletId = parseInt(walletIdQuery as string, 10);
      }

      const trades = await db.prisma.trade.findMany({
        where,
        orderBy: { createdAt: "asc" },
      });

      const wallets = await db.findWalletsByUserId(userId);
      const selectedWallets = walletIdQuery
        ? wallets.filter(w => w.id === parseInt(walletIdQuery as string, 10))
        : wallets;

      const registry = DEXRegistry.getInstance();
      const tokens = await registry.getSwappableTokens();
      const pm = PortfolioManager.getInstance();
      const stxPrice = await registry.getTokenPrice("STX") || 2.0;

      const currentAggregatedBalances = new Map<string, { token: string, symbol: string, balance: number }>();
      
      const tokenResolver = new Map<string, string>();
      for (const t of tokens) {
        tokenResolver.set(t.contractId.toUpperCase(), t.symbol.toUpperCase());
        tokenResolver.set(t.symbol.toUpperCase(), t.symbol.toUpperCase());
      }
      tokenResolver.set("STX", "STX");

      const getSymbol = (tokenStr: string): string => {
        const normalized = tokenStr.toUpperCase();
        const baseContractId = normalized.split("::")[0] || normalized;
        return tokenResolver.get(normalized) || tokenResolver.get(baseContractId) || normalized;
      };

      for (const w of selectedWallets) {
        try {
          const wBalances = await pm.fetchBalances(w.address, tokens, userId, true);
          for (const b of wBalances) {
            const sym = getSymbol(b.symbol);
            const existing = currentAggregatedBalances.get(sym);
            if (existing) {
              existing.balance += b.balance;
            } else {
              currentAggregatedBalances.set(sym, {
                token: b.token,
                symbol: b.symbol,
                balance: b.balance
              });
            }
          }
        } catch (err) {
          const existing = currentAggregatedBalances.get("STX");
          if (existing) {
            existing.balance += w.balance;
          } else {
            currentAggregatedBalances.set("STX", {
              token: "STX",
              symbol: "STX",
              balance: w.balance
            });
          }
        }
      }

      const tokensToFetch = new Set<string>();
      for (const [_, b] of currentAggregatedBalances) {
        tokensToFetch.add(getSymbol(b.symbol));
      }
      for (const t of trades) {
        tokensToFetch.add(getSymbol(t.tokenIn));
        tokensToFetch.add(getSymbol(t.tokenOut));
      }

      const candleMap = new Map<string, CandleData[]>();
      await Promise.all(
        Array.from(tokensToFetch).map(async (tokenSymbol) => {
          try {
            const candles = await candleService.getCandles(tokenSymbol, candleTf, limit * 2);
            candleMap.set(tokenSymbol, candles);
          } catch (err) {
            logger.warn(`Failed to fetch candles for token ${tokenSymbol}`, { err });
          }
        })
      );

      const getPriceAtTimestamp = async (tokenSymbol: string, timestamp: Date): Promise<number> => {
        const candles = candleMap.get(tokenSymbol) || [];
        if (candles.length > 0) {
          const exact = candles.find(c => c.timestamp.getTime() === timestamp.getTime());
          if (exact) return exact.close;

          const before = candles.filter(c => c.timestamp.getTime() <= timestamp.getTime());
          if (before.length > 0) {
            return before.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]!.close;
          }
          return candles[0]!.close;
        }

        const currentPrice = await registry.getTokenPrice(tokenSymbol).catch(() => 0);
        return currentPrice || (tokenSymbol === "STX" ? 2.0 : 1.0);
      };

      const runningBalances = new Map<string, number>();
      for (const [sym, b] of currentAggregatedBalances.entries()) {
        runningBalances.set(sym, b.balance);
      }

      const sortedTradesForReversing = [...trades].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
      );

      const periodBalances = new Array<Map<string, number>>(limit);
      let tradeIdx = 0;

      for (let j = limit - 1; j >= 0; j--) {
        const tj = periods[j]!;
        while (
          tradeIdx < sortedTradesForReversing.length &&
          sortedTradesForReversing[tradeIdx]!.createdAt.getTime() > tj.getTime()
        ) {
          const trade = sortedTradesForReversing[tradeIdx]!;
          const symIn = getSymbol(trade.tokenIn);
          const symOut = getSymbol(trade.tokenOut);

          const balIn = runningBalances.get(symIn) ?? 0;
          const balOut = runningBalances.get(symOut) ?? 0;

          runningBalances.set(symIn, balIn + trade.amountIn);
          runningBalances.set(symOut, Math.max(0, balOut - trade.amountOut));

          tradeIdx++;
        }
        periodBalances[j] = new Map(runningBalances);
      }

      const periodTrades = new Array<any[]>(limit);
      for (let j = 0; j < limit; j++) {
        periodTrades[j] = [];
      }

      for (const trade of trades) {
        const tTime = trade.createdAt.getTime();
        for (let j = 0; j < limit; j++) {
          const start = periods[j]!.getTime();
          const end = j === limit - 1 ? Infinity : periods[j + 1]!.getTime();
          if (tTime >= start && tTime < end) {
            periodTrades[j]!.push(trade);
            break;
          }
        }
      }

      const chartData: any[] = [];
      for (let j = 0; j < limit; j++) {
        const tj = periods[j]!;
        const balancesAtPeriod = periodBalances[j]!;
        const tradesAtPeriod = periodTrades[j]!;

        let portfolioValue = 0;
        for (const [sym, bal] of balancesAtPeriod.entries()) {
          if (bal <= 0) continue;
          const price = await getPriceAtTimestamp(sym, tj);
          portfolioValue += bal * price;
        }

        let periodVolume = 0;
        let periodBuys = 0;
        let periodSells = 0;

        for (const t of tradesAtPeriod) {
          const priceIn = await registry.getTokenPrice(t.tokenIn).catch(() => 1.0);
          const amountInUsd = t.amountInUsd ?? (t.tokenIn === "STX" ? t.amountIn * stxPrice : t.amountIn * priceIn);
          periodVolume += amountInUsd;
          if (t.direction === "BUY") {
            periodBuys += 1;
          } else {
            periodSells += 1;
          }
        }

        let dateStr: string;
        if (timeframe === "1d") {
          const hours = String(tj.getHours()).padStart(2, "0");
          const mins = String(tj.getMinutes()).padStart(2, "0");
          dateStr = `${hours}:${mins}`;
        } else {
          dateStr = tj.toISOString().split("T")[0] as string;
        }

        chartData.push({
          date: dateStr,
          timestamp: tj.getTime(),
          portfolioValue,
          pnl: 0,
          volume: periodVolume,
          buys: periodBuys,
          sells: periodSells,
        });
      }

      const V0 = chartData.length > 0 ? chartData[0].portfolioValue : 0;
      chartData.forEach(pt => {
        pt.pnl = pt.portfolioValue - V0;
      });

      const totalVolume = trades.reduce((sum, t) => {
        const amountInUsd = t.amountInUsd ?? (t.tokenIn === "STX" ? t.amountIn * stxPrice : t.amountIn * (stxPrice || 1.0));
        return sum + amountInUsd;
      }, 0);

      const totalProfit = chartData.length > 0 ? chartData[chartData.length - 1].portfolioValue - V0 : 0;

      res.json({
        summary: {
          totalTrades: trades.length,
          totalVolume,
          totalProfit,
        },
        chartData,
      });
    } catch (error) {
      logger.error("Failed to generate analytics", { error });
      next(new InternalError());
    }
  }
}
