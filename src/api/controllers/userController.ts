import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import { DatabaseService } from "../../services/db.js";
import { DEXRegistry } from "../../services/dex/dexRegistry.js";
import type { DEXQuote } from "../../types/dexProvider.js";
import type { SwappableToken } from "../../types.js";
import { PortfolioManager } from "../../services/portfolio.js";
import { KMSService } from "../../services/kms.js";
import { RiskManager } from "../../services/riskManager.js";
import { ChainAdapterRegistry } from "../../services/chains/chainAdapterRegistry.js";
import {
  walletChainId,
  walletDescriptor,
  groupByChainId,
  explorerTxUrlFor,
} from "../../services/chains/walletChain.js";
import { resolveChainId } from "../../services/chains/executeSwap.js";
import { executeSwapPayload } from "../../services/chains/executeSwap.js";
import { logger } from "../../utils/logger.js";
import { encrypt } from "../../utils/crypto.js";
import { QueueManager } from "../../services/queue.js";
import {
  PortfolioAnalyticsService,
  type Timeframe,
} from "../../services/portfolioAnalytics.js";
import { sponsorshipAvailability } from "../../services/chains/gasSponsorship.js";
import { resolveTradeSettings, DEFAULT_TRADE_SETTINGS } from "../../services/tradeSettings.js";
import { SocialVerificationService } from "../../services/social/verification.js";
import { SocialRegistry } from "../../services/social/socialRegistry.js";
import { ConfigManager } from "../../config.js";
import {
  NotFoundError,
  InternalError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  UnauthorizedError,
  AppError,
  messageOf,
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
      const pm = PortfolioManager.getInstance();
      // Token list and native-asset price are per chain, so resolve them once
      // per distinct chain present rather than once globally as "STX". Keyed by
      // ChainId, not family — Base and Celo are both "evm" but share neither a
      // token universe nor a native asset.
      const chainIds = [...groupByChainId(wallets).keys()];
      const perChain = new Map<string, { tokens: SwappableToken[]; nativeSymbol: string; nativePrice: number }>();
      await Promise.all(
        chainIds.map(async (chainId) => {
          const descriptor = walletDescriptor({ chain: chainId });
          const nativeSymbol = descriptor.nativeSymbol;
          const [tokens, price] = await Promise.all([
            registry.getSwappableTokens(false, chainId),
            registry.getTokenPrice(nativeSymbol, chainId).catch(() => 0),
          ]);
          perChain.set(chainId, {
            tokens,
            nativeSymbol,
            // No fabricated fallback price for non-Stacks chains: this number
            // feeds RiskManager position sizing, and a guessed price there is
            // worse than an unpriced balance.
            nativePrice: price || (descriptor.family === "stacks" ? 2.0 : 0),
          });
        })
      );

      const updatedWallets = await Promise.all(
        wallets.map(async (w) => {
          const chainId = walletChainId(w);
          const family = w.chainFamily ?? "stacks";
          const { tokens, nativeSymbol, nativePrice } = perChain.get(chainId)!;
          try {
            const balances = await pm.fetchBalances(w.address, tokens, req.userId!);
            const nativeBal = balances.find((b) => b.symbol === nativeSymbol)?.balance ?? 0;
            const totalWalletUsd = balances.reduce((sum, b) => sum + (b.usdValue ?? 0), 0);
            await db.updateWalletBalance(w.id, nativeBal);
            return {
              id: w.id,
              address: w.address,
              name: w.name,
              chainFamily: family,
              chain: w.chain,
              balance: nativeBal,
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
              chainFamily: family,
              chain: w.chain,
              balance: w.balance,
              balanceUsd: w.balance * nativePrice,
              balances: [
                {
                  token: nativeSymbol,
                  symbol: nativeSymbol,
                  balance: w.balance,
                  usdValue: w.balance * nativePrice,
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
            wallet: { select: { name: true, address: true, chain: true, chainFamily: true } },
          },
        }),
        db.prisma.trade.count({ where }),
      ]);

      const items = trades.map((t) => {
        // The trade's own chain, falling back to the wallet's for rows that
        // predate the column.
        const chainId = t.chain ?? walletChainId(t.wallet);
        return {
          id: t.id,
          walletName: t.wallet.name,
          walletAddress: t.wallet.address,
          chain: chainId,
          direction: t.direction,
          tokenIn: t.tokenIn,
          tokenOut: t.tokenOut,
          amountIn: t.amountIn,
          amountOut: t.amountOut,
          amountInUsd: t.amountInUsd,
          amountOutUsd: t.amountOutUsd,
          txId: t.txId,
          // Built here rather than in each client. Four separate surfaces were
          // composing a Hiro URL by hand, so every non-Stacks trade linked to
          // an explorer that has never heard of it.
          explorerUrl: explorerTxUrlFor(chainId, t.txId),
          status: t.status,
          errorMessage: t.errorMessage,
          createdAt: t.createdAt,
          confirmedAt: t.confirmedAt,
        };
      });

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

      const [settings, chainPreferences] = await Promise.all([
        db.findTradeSettings(req.userId!, context),
        db.findChainPreferences(req.userId!),
      ]);

      // Per-chain overrides ride along, so the settings page can show which
      // chains diverge from the account default without a second round trip.
      // Only the chains this deployment runs are listed: a preference left over
      // from a chain since removed from ENABLED_CHAINS is not something the
      // user can act on.
      const enabled = new Set(
        ChainAdapterRegistry.getInstance().list().map((d) => d.chainId)
      );

      res.json({
        ...(settings ?? { context, ...DEFAULT_TRADE_SETTINGS }),
        chains: chainPreferences
          .filter((p) => enabled.has(p.chainId))
          .map((p) => ({ chainId: p.chainId, slippageBps: p.slippageBps })),
      });
    } catch (error) {
      logger.error("Failed to fetch settings", { error });
      next(new InternalError());
    }
  }

  static async updateSettings(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const db = DatabaseService.getInstance();
      const data = req.body as {
        context?: string;
        /**
         * When present, slippage is stored as an override for this chain
         * rather than as the account default. Null clears the override.
         */
        chainId?: string;
        slippageBps?: number;
        maxPositionPct?: number;
        dailyLossLimit?: number;
        rebalanceThreshold?: number;
        useGasless?: boolean;
        gaslessFeeToken?: string;
      };

      if (data.chainId) {
        const descriptor = ChainAdapterRegistry.getInstance().find(data.chainId);
        if (!descriptor) {
          return next(
            new ValidationError(`Chain "${data.chainId}" is not enabled on this deployment`)
          );
        }

        // Only slippage is per chain. Position and loss limits bound the
        // account's total exposure, and expressing them per chain would let a
        // user with three chains take three times the position they asked to
        // be limited to.
        await db.upsertChainPreference({
          userId: req.userId!,
          chainId: data.chainId,
          slippageBps: data.slippageBps ?? null,
        });

        return res.json(
          await resolveTradeSettings(req.userId!, data.context ?? "personal", data.chainId)
        );
      }

      const settings = await db.upsertTradeSettings({
        userId: req.userId!,
        context: data.context ?? "personal",
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

  static async generateWallet(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { name, chainId, chainFamily } = req.body as {
        name?: string;
        chainId?: string;
        chainFamily?: string;
      };
      const db = DatabaseService.getInstance();

      // chainId is the real identifier; chainFamily is accepted for clients
      // written before multi-EVM and resolves to that family's default network.
      const targetChain = resolveChainId({ chainId, chainFamily });
      const adapters = ChainAdapterRegistry.getInstance();
      if (!adapters.has(targetChain)) {
        return next(
          new ValidationError(
            `Chain "${targetChain}" is not enabled on this deployment. ` +
            `Enabled: ${adapters.list().map((d) => d.chainId).join(", ") || "(none)"}`
          )
        );
      }
      const adapter = adapters.get(targetChain);

      const existing = await db.findWalletsByUserId(req.userId!);
      const walletName = name?.trim() || `Wallet ${existing.length + 1}`;

      const { privateKey, address } = await adapter.generateWalletKeypair();
      const encryptedKey = encrypt(privateKey);

      const wallet = await db.createWallet({
        userId: req.userId!,
        address,
        name: walletName,
        encryptedKey,
        chainFamily: adapter.chainFamily,
        chain: adapter.chainId(),
      });

      logger.info("Wallet generated", { userId: req.userId, address, chain: adapter.chainId() });

      res.status(201).json({
        id: wallet.id,
        address: wallet.address,
        name: wallet.name,
        chainFamily: wallet.chainFamily,
        chain: wallet.chain,
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
      const { privateKey, name, chainId, chainFamily } = req.body as {
        privateKey: string;
        name?: string;
        chainId?: string;
        chainFamily?: string;
      };
      const db = DatabaseService.getInstance();

      const targetChain = resolveChainId({ chainId, chainFamily });
      const adapters = ChainAdapterRegistry.getInstance();
      if (!adapters.has(targetChain)) {
        return next(
          new ValidationError(
            `Chain "${targetChain}" is not enabled on this deployment. ` +
            `Enabled: ${adapters.list().map((d) => d.chainId).join(", ") || "(none)"}`
          )
        );
      }
      const adapter = adapters.get(targetChain);

      let address: string;
      try {
        address = await adapter.deriveAddressFromPrivateKey(privateKey.trim());
      } catch {
        return next(new ValidationError(`Invalid ${adapter.descriptor.displayName} private key`));
      }

      // Scoped by family: the same key material imported on two chains is two
      // distinct wallets, and only a collision within one chain is a duplicate.
      const existing = await db.findWalletByAddress(address, adapter.chainFamily);
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
        chainFamily: adapter.chainFamily,
        chain: adapter.chainId(),
      });

      logger.info("Wallet imported", { userId: req.userId, address, chain: adapter.chainId() });

      const registry = DEXRegistry.getInstance();
      const tokens = await registry.getSwappableTokens(false, targetChain);
      const balances = await PortfolioManager.getInstance().fetchBalances(wallet.address, tokens, req.userId!);
      const nativeBal = balances.find((b) => b.symbol === adapter.nativeSymbol)?.balance ?? 0;

      const nativePrice = await registry.getTokenPrice(adapter.nativeSymbol, targetChain)
        || (adapter.chainFamily === "stacks" ? 2.0 : 0);

      await db.updateWalletBalance(wallet.id, nativeBal);

      res.status(201).json({
        id: wallet.id,
        address: wallet.address,
        name: wallet.name,
        chainFamily: wallet.chainFamily,
        chain: wallet.chain,
        balance: nativeBal,
        balanceUsd: nativeBal * nativePrice,
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
      const tokens = await registry.getSwappableTokens(false, walletChainId(wallet));
      const balances = await PortfolioManager.getInstance().fetchBalances(wallet.address, tokens, req.userId!, true);

      res.json(balances);
    } catch (error) {
      logger.error("Failed to fetch wallet balances", { error });
      next(new AppError(messageOf(error, "Failed to fetch wallet balances"), 502, "BAD_GATEWAY"));
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

      const chainId = walletChainId(wallet);
      const adapters = ChainAdapterRegistry.getInstance();
      if (!adapters.has(chainId)) {
        return next(new ValidationError(`Chain "${chainId}" is not enabled on this deployment`));
      }
      const adapter = adapters.get(chainId);

      const registry = DEXRegistry.getInstance();
      const tokens = await registry.getSwappableTokens(false, chainId);
      const tokenObj = tokens.find(t => t.contractId === token || t.symbol === token);
      // Unknown-token fallback is the chain's native decimals — 6 on Stacks
      // (unchanged) and 18 on EVM, where assuming 6 would be off by 1e12.
      const decimals = tokenObj ? tokenObj.decimals : adapter.nativeDecimals;
      const isNative = token.toUpperCase() === adapter.nativeSymbol.toUpperCase();

      const result = await adapter.transfer({
        walletId: wallet.id,
        senderAddress: wallet.address,
        toAddress,
        amount,
        token: isNative ? adapter.nativeSymbol : (tokenObj ? tokenObj.contractId : token),
        decimals,
      });

      if ("txId" in result) {
        return res.json({
          ok: true,
          txId: result.txId,
          chain: chainId,
          explorerUrl: explorerTxUrlFor(chainId, result.txId),
        });
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
      const chainId = walletChainId(wallet);

      const registry = DEXRegistry.getInstance();
      const tokens = await registry.getSwappableTokens(false, chainId);
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

      const settings = await resolveTradeSettings(req.userId!, "personal", chainId);
      const riskAction = { tokenIn, tokenOut, amountIn, direction: direction as "BUY" | "SELL", reason: "Manual trade via web" };
      const riskResult = await RiskManager.getInstance().evaluateTrade(
        req.userId!,
        riskAction,
        balances,
        {
          slippageBps: settings.slippageBps,
          maxPositionPct: settings.maxPositionPct,
          dailyLossLimit: settings.dailyLossLimit,
        }
      );
      if (!riskResult.approved) {
        return res.status(400).json({ error: riskResult.reason ?? "Trade rejected by risk manager" });
      }

      let selectedProviderName: string;
      let est: DEXQuote;

      if (dex) {
        const provider = registry.getProvider(dex);
        if (!provider) {
          return res.status(400).json({ error: `Selected DEX provider '${dex}' is not registered` });
        }
        // Scoped by network, not family: every EVM DEX shares the family
        // "evm", so a family check would happily hand a Base wallet a Celo
        // router whose addresses don't exist on Base.
        if (!registry.getProvidersForChain(chainId).some((p) => p.name === provider.name)) {
          return res.status(400).json({ error: `Selected DEX provider '${dex}' does not support this wallet's chain` });
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
        const bestQuoteResult = await registry.getBestQuote(tokenIn, tokenOut, amountIn, chainId);
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

      const useGasless = settings?.useGasless ?? false;

      const result = await executeSwapPayload(payload, {
        action: riskAction,
        walletId: wallet.id,
        senderAddress: wallet.address,
        maxOutbound: est.amountOut,
        useGasless,
        chainId,
      });

      if ("txId" in result) {
        const trade = await db.createTrade({
          walletId: wallet.id, userId: req.userId!,
          direction, tokenIn, tokenOut,
          amountIn, amountOut: est.amountOut,
          feeAmount: est.feeAmount, feeBps: est.feeBps,
        });
        await db.updateTradeStatus(trade.id, "BROADCAST", result.txId);
        return res.json({
          ok: true,
          tradeId: trade.id,
          txId: result.txId,
          chain: chainId,
          explorerUrl: explorerTxUrlFor(chainId, result.txId),
          estimate: est,
          dex: selectedProviderName,
        });
      }

      res.status(500).json({ error: result.error });
    } catch (error) {
      logger.error("Trade execution failed", { error });
      next(new InternalError());
    }
  }

  static async getTradeQuote(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { tokenIn, tokenOut, amountIn, walletId, chainId } = req.query as {
        tokenIn?: string;
        tokenOut?: string;
        amountIn?: string;
        walletId?: string;
        chainId?: string;
      };
      if (!tokenIn || !tokenOut || !amountIn) {
        return res.status(400).json({ error: "tokenIn, tokenOut, and amountIn are required" });
      }

      const amt = parseFloat(amountIn);
      if (isNaN(amt) || amt <= 0) {
        return res.status(400).json({ error: "amountIn must be a positive number" });
      }

      // Scoped to one chain, which this endpoint previously wasn't: it asked
      // every provider on every chain and returned whichever answered. That is
      // the exact hazard CLAUDE.md calls out — a Base wallet quoted by a Celo
      // router — and it only looked correct because one chain usually happens
      // to be the only one that can route a given pair.
      //
      // The wallet is the better source than a bare chainId: it is what the
      // trade will actually execute from, so a quote for a different chain is
      // a quote for a trade that cannot happen.
      let scope: string | undefined = chainId;

      if (walletId) {
        const wallet = await DatabaseService.getInstance().findWalletById(Number(walletId));
        if (!wallet || wallet.userId !== req.userId!) {
          return next(new NotFoundError("Wallet"));
        }
        scope = walletChainId(wallet);
      }

      const registry = DEXRegistry.getInstance();
      const quotes = await registry.getAllQuotes(tokenIn, tokenOut, amt, scope);
      if (quotes.length === 0) {
        return res.status(400).json({
          error: scope
            ? `No swap route found for this pair on ${scope}`
            : "No swap route found for this pair on any DEX",
        });
      }

      const best = quotes[0]!;

      res.json({
        tokenIn, tokenOut, amountIn: amt, chainId: scope ?? null,
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
      next(new AppError(messageOf(error, "Quote fetch failed"), 502, "BAD_GATEWAY"));
    }
  }

  static async getAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const raw = String(req.query.timeframe ?? "7d").toLowerCase();
      const timeframe: Timeframe = (["1d", "7d", "30d", "all"] as const).includes(raw as Timeframe)
        ? (raw as Timeframe)
        : "7d";

      const walletIdQuery = req.query.walletId;
      const walletId = walletIdQuery ? parseInt(String(walletIdQuery), 10) : undefined;

      const result = await PortfolioAnalyticsService.getInstance().compute(
        req.userId!,
        timeframe,
        Number.isFinite(walletId) ? walletId : undefined
      );

      res.json(result);
    } catch (error) {
      logger.error("Failed to generate analytics", { error });
      next(new InternalError());
    }
  }


  /**
   * Per-chain gas-sponsorship state.
   *
   * Reports every enabled chain, including the ones that can't sponsor —
   * with the reason. Listing only the capable chains would leave a user
   * wondering why Celo has no toggle, and "it uses EOA custody, which pays its
   * own gas" is a better answer than an absent row.
   */
  static async getGasSponsorship(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const db = DatabaseService.getInstance();
      const chains = ChainAdapterRegistry.getInstance().list();

      const preferences = await db.findChainPreferences(req.userId!);
      const chosen = new Map(preferences.map((p) => [p.chainId, p.sponsorGas]));

      res.json({
        chains: chains.map((descriptor) => {
          const { available, reason } = sponsorshipAvailability(descriptor);
          return {
            chainId: descriptor.chainId,
            displayName: descriptor.displayName,
            nativeSymbol: descriptor.nativeSymbol,
            available,
            reason,
            // Defaults to on, matching how every 4337 wallet behaved before
            // the toggle existed.
            // `?? true` covers both "no row" and "row with no opinion": null
            // means inherit, and the inherited answer is sponsored.
            enabled: available && (chosen.get(descriptor.chainId) ?? true),
          };
        }),
      });
    } catch (error) {
      logger.error("Failed to fetch gas sponsorship settings", { error });
      next(new InternalError());
    }
  }

  static async updateGasSponsorship(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<Response | void> {
    try {
      const { chainId, enabled } = req.body as { chainId: string; enabled: boolean };

      const registry = ChainAdapterRegistry.getInstance();
      const descriptor = registry.find(chainId);
      if (!descriptor) {
        return next(new ValidationError(`Chain "${chainId}" is not enabled on this deployment`));
      }

      // Refused rather than stored-and-ignored. A setting that persists but
      // does nothing is worse than an error: the user believes they turned
      // sponsorship on and finds out otherwise when a swap reverts.
      const { available, reason } = sponsorshipAvailability(descriptor);
      if (!available) {
        return next(new ValidationError(reason ?? "This chain cannot sponsor gas"));
      }

      // ChainPreference, not TradeSettings. Writing this into the account
      // table by (userId, chain) is what used to insert a second
      // (userId, "personal") row full of default risk limits, after which the
      // unordered lookup every risk reader used could return either one.
      await DatabaseService.getInstance().upsertChainPreference({
        userId: req.userId!,
        chainId,
        sponsorGas: enabled,
      });

      res.json({ ok: true, chainId, enabled });
    } catch (error) {
      logger.error("Failed to update gas sponsorship", { error });
      next(new InternalError());
    }
  }

  static async getSocialAccounts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const db = DatabaseService.getInstance();
      const accounts = await db.prisma.socialAccount.findMany({
        where: { userId: req.userId! },
        orderBy: { createdAt: "asc" },
      });

      res.json(accounts);
    } catch (error) {
      logger.error("Failed to fetch social accounts", { error });
      next(new InternalError());
    }
  }

  /**
   * Opens a "post this code" challenge.
   *
   * There is deliberately no endpoint that creates a SocialAccount directly.
   * The one that existed took `platformUserId` from the request body and then
   * set `verifiedAt` — so the column recorded that the user had asserted
   * ownership, which is not what anyone reading it would assume. The account
   * row is now created only by the mention poller, from an id the platform
   * itself supplied.
   */
  static async startSocialVerification(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<Response | void> {
    try {
      const { platform } = req.body as { platform: "x" | "farcaster" };

      const provider = SocialRegistry.getInstance().get(platform);
      if (!provider) {
        return next(
          new ValidationError(
            `${platform} is not configured on this deployment — no credentials, or social trading is disabled.`
          )
        );
      }

      const pending = await SocialVerificationService.getInstance().start(req.userId!, platform);
      const handles = ConfigManager.getInstance().config.SOCIAL_BOT_HANDLES.split(",")[0]?.trim();

      res.status(201).json({
        ...pending,
        // The exact text to post. Handing over a ready-made string is not
        // decoration: a user who paraphrases it and omits the mention posts
        // something the bot never sees, and then waits for a link that cannot
        // arrive.
        postText: `${pending.code} — verifying my account with @${handles || "astroidbot"}`,
      });
    } catch (error) {
      logger.error("Failed to start social verification", { error });
      next(new InternalError());
    }
  }

  static async getSocialVerification(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const platform = String(req.query.platform ?? "x");
      const pending = await SocialVerificationService.getInstance().pending(req.userId!, platform);
      res.json({ pending });
    } catch (error) {
      logger.error("Failed to read social verification", { error });
      next(new InternalError());
    }
  }

  static async updateSocialAccount(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const id = parseInt(String(req.params.id ?? "0"), 10);
      if (!id) return next(new ValidationError("Invalid account id"));

      const db = DatabaseService.getInstance();
      const account = await db.prisma.socialAccount.findUnique({ where: { id } });
      if (!account) return next(new NotFoundError("Social account"));
      if (account.userId !== req.userId!) return next(new ForbiddenError());

      const data = req.body as {
        perTradeLimitUsd?: number;
        dailyLimitUsd?: number;
        autoExecute?: boolean;
        enabled?: boolean;
      };

      const updated = await db.prisma.socialAccount.update({
        where: { id },
        data: {
          ...(data.perTradeLimitUsd !== undefined && { perTradeLimitUsd: data.perTradeLimitUsd }),
          ...(data.dailyLimitUsd !== undefined && { dailyLimitUsd: data.dailyLimitUsd }),
          ...(data.autoExecute !== undefined && { autoExecute: data.autoExecute }),
          ...(data.enabled !== undefined && { enabled: data.enabled }),
        },
      });

      res.json(updated);
    } catch (error) {
      logger.error("Failed to update social account", { error });
      next(new InternalError());
    }
  }

  static async deleteSocialAccount(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const id = parseInt(String(req.params.id ?? "0"), 10);
      if (!id) return next(new ValidationError("Invalid account id"));

      const db = DatabaseService.getInstance();
      const account = await db.prisma.socialAccount.findUnique({ where: { id } });
      if (!account) return next(new NotFoundError("Social account"));
      if (account.userId !== req.userId!) return next(new ForbiddenError());

      await db.prisma.socialAccount.delete({ where: { id } });
      res.json({ ok: true });
    } catch (error) {
      logger.error("Failed to delete social account", { error });
      next(new InternalError());
    }
  }

  static async getPendingSocialCommand(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const token = String(req.query.token ?? "");
      if (!token) return next(new ValidationError("Confirmation token is required"));

      const db = DatabaseService.getInstance();
      const command = await db.prisma.socialCommand.findUnique({
        where: { confirmToken: token },
        include: { socialAccount: true },
      });

      if (!command || command.status !== "AWAITING_CONFIRMATION") {
        return next(new NotFoundError("Pending trade confirmation not found or already processed"));
      }

      if (command.confirmExpiresAt && command.confirmExpiresAt < new Date()) {
        return next(new ValidationError("Confirmation link has expired (5 minute TTL)"));
      }

      let parsedIntent = null;
      if (command.parsedIntent) {
        try {
          parsedIntent = JSON.parse(command.parsedIntent);
        } catch {
          parsedIntent = null;
        }
      }

      res.json({
        ok: true,
        command: {
          id: command.id,
          platform: command.platform,
          postId: command.postId,
          authorId: command.authorId,
          rawText: command.rawText,
          parsedIntent,
          confirmExpiresAt: command.confirmExpiresAt,
          status: command.status,
        },
      });
    } catch (error) {
      logger.error("Failed to fetch pending social command", { error });
      next(new InternalError());
    }
  }

  static async confirmSocialCommand(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { token } = req.body as { token: string };
      if (!token) return next(new ValidationError("Token is required"));

      const db = DatabaseService.getInstance();
      const command = await db.prisma.socialCommand.findUnique({
        where: { confirmToken: token },
        include: { socialAccount: true },
      });

      if (!command || command.status !== "AWAITING_CONFIRMATION") {
        return next(new NotFoundError("Pending social command not found or already processed"));
      }

      if (command.confirmExpiresAt && command.confirmExpiresAt < new Date()) {
        return next(new ValidationError("Confirmation link has expired"));
      }

      if (!command.socialAccount || command.socialAccount.userId !== req.userId!) {
        return next(new ForbiddenError("You are not authorized to confirm this trade"));
      }

      if (!command.parsedIntent) {
        return next(new ValidationError("Command has no valid parsed intent"));
      }

      const intent = JSON.parse(command.parsedIntent) as {
        action: "buy" | "sell";
        amount: number;
        denomination: "usd" | "token";
        token: string;
        chainHint?: string;
      };

      const wallets = await db.findWalletsByUserId(req.userId!);
      if (wallets.length === 0) {
        return next(new ValidationError("No wallet found to execute trade"));
      }

      const defaultWallet = await db.findDefaultWalletByUserId(req.userId!) ?? wallets[0]!;

      await QueueManager.getInstance().enqueueTrade({
        walletId: defaultWallet.id,
        userId: req.userId!,
        senderAddress: defaultWallet.address,
        tokenIn: intent.action === "buy" ? "USDC" : intent.token,
        tokenOut: intent.action === "buy" ? intent.token : "USDC",
        amountIn: intent.amount,
        direction: intent.action === "buy" ? "BUY" : "SELL",
        reason: `Social command confirmed via web (${command.platform})`,
      });

      await db.prisma.socialCommand.update({
        where: { id: command.id },
        data: { status: "EXECUTED" },
      });

      res.json({ ok: true, message: "Social trade confirmed and enqueued successfully" });
    } catch (error) {
      logger.error("Failed to confirm social command", { error });
      next(new InternalError());
    }
  }
}

