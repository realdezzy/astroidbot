import { PrismaClient, Prisma } from "@prisma/client";
import crypto from "node:crypto";
import { logger } from "../utils/logger.js";
import { ConfigManager } from "../config.js";

export class DatabaseService {
  private static instance: DatabaseService;
  public readonly prisma: PrismaClient;

  private constructor() {
    const url = ConfigManager.getInstance().config.ASTROIDBOT_DATABASE_URL;

    this.prisma = new PrismaClient({
      datasources: {
        db: { url },
      },
    });
  }

  static connect(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      throw new Error("DatabaseService not initialized. Call DatabaseService.connect() first.");
    }
    return DatabaseService.instance;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      logger.info("Database health check passed");
      return true;
    } catch (error) {
      logger.error("Database health check failed", { error });
      return false;
    }
  }

  async disconnect(): Promise<void> {
    logger.info("Disconnecting from database");
    await this.prisma.$disconnect();
  }

  // ---------- User ----------

  async findUserByTelegramId(telegramId: bigint) {
    return this.prisma.user.findUnique({ where: { telegramId } });
  }

  async findUserById(id: number) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async createUser(data: {
    telegramId: bigint;
    username?: string;
    referredBy?: number;
  }) {
    return this.prisma.user.create({
      data: {
        telegramId: data.telegramId,
        username: data.username,
        referredBy: data.referredBy,
      },
    });
  }

  async addPoints(userId: number, points: number) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { points: { increment: points } },
    });
  }

  // ---------- Wallet ----------

  async findWalletById(id: number) {
    return this.prisma.wallet.findUnique({ where: { id } });
  }

  async findWalletsByUserId(userId: number) {
    return this.prisma.wallet.findMany({ where: { userId } });
  }

  async findWalletByAddress(address: string) {
    return this.prisma.wallet.findUnique({ where: { address } });
  }

  async createWallet(data: {
    userId: number;
    address: string;
    name: string;
    encryptedKey: string;
  }) {
    return this.prisma.wallet.create({ data });
  }

  async updateWalletBalance(walletId: number, balance: number) {
    return this.prisma.wallet.update({
      where: { id: walletId },
      data: { balance },
    });
  }

  // ---------- TradeSettings ----------

  async findTradeSettings(userId: number, context: string) {
    return this.prisma.tradeSettings.findFirst({
      where: { userId, context },
    });
  }

  async upsertTradeSettings(data: {
    userId: number;
    context: string;
    chain?: string;
    slippageBps?: number;
    maxPositionPct?: number;
    dailyLossLimit?: number;
    rebalanceThreshold?: number;
    useGasless?: boolean;
    gaslessFeeToken?: string;
  }) {
    return this.prisma.tradeSettings.upsert({
      where: {
        id: (
          (await this.findTradeSettings(data.userId, data.context))?.id ?? 0
        ),
      },
      create: {
        userId: data.userId,
        context: data.context,
        chain: data.chain ?? "stacks:mainnet",
        slippageBps: data.slippageBps ?? 100,
        maxPositionPct: data.maxPositionPct ?? 25.0,
        dailyLossLimit: data.dailyLossLimit ?? 5.0,
        rebalanceThreshold: data.rebalanceThreshold ?? 2.0,
        useGasless: data.useGasless ?? false,
        gaslessFeeToken: data.gaslessFeeToken ?? "USDC",
      },
      update: {
        chain: data.chain,
        slippageBps: data.slippageBps,
        maxPositionPct: data.maxPositionPct,
        dailyLossLimit: data.dailyLossLimit,
        rebalanceThreshold: data.rebalanceThreshold,
        useGasless: data.useGasless,
        gaslessFeeToken: data.gaslessFeeToken,
      },
    });
  }

  // ---------- Trade ----------

  async createTrade(data: {
    walletId: number;
    userId: number;
    direction: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: number;
    amountOut: number;
    feeAmount?: number;
    feeBps?: number;
    amountInUsd?: number;
    amountOutUsd?: number;
  }) {
    let amountInUsd = data.amountInUsd;
    let amountOutUsd = data.amountOutUsd;

    if (amountInUsd === undefined || amountOutUsd === undefined) {
      try {
        const { DEXRegistry } = await import("./dex/dexRegistry.js");
        const registry = DEXRegistry.getInstance();
        const priceIn = await registry.getTokenPrice(data.tokenIn);
        const priceOut = await registry.getTokenPrice(data.tokenOut);

        if (amountInUsd === undefined) {
          amountInUsd = data.amountIn * (priceIn || (data.tokenIn.toUpperCase() === "SUSDT" || data.tokenIn.toUpperCase() === "USDA" ? 1 : 0));
        }
        if (amountOutUsd === undefined) {
          amountOutUsd = data.amountOut * (priceOut || (data.tokenOut.toUpperCase() === "SUSDT" || data.tokenOut.toUpperCase() === "USDA" ? 1 : 0));
        }
      } catch {
        // ignore errors
      }
    }

    return this.prisma.trade.create({
      data: {
        walletId: data.walletId,
        userId: data.userId,
        direction: data.direction,
        tokenIn: data.tokenIn,
        tokenOut: data.tokenOut,
        amountIn: data.amountIn,
        amountOut: data.amountOut,
        feeAmount: data.feeAmount ?? 0,
        feeBps: data.feeBps ?? 30,
        status: "PENDING",
        amountInUsd,
        amountOutUsd,
      },
    });
  }

  async updateTradeStatus(
    tradeId: number,
    status: string,
    txId?: string,
    errorMessage?: string
  ) {
    const extraData: Record<string, any> = {};
    if (status === "CONFIRMED") {
      extraData.confirmedAt = new Date();
      try {
        const trade = await this.prisma.trade.findUnique({ where: { id: tradeId } });
        if (trade && (!trade.amountInUsd || !trade.amountOutUsd)) {
          const { DEXRegistry } = await import("./dex/dexRegistry.js");
          const registry = DEXRegistry.getInstance();
          const priceIn = await registry.getTokenPrice(trade.tokenIn);
          const priceOut = await registry.getTokenPrice(trade.tokenOut);

          extraData.amountInUsd = trade.amountIn * (priceIn || (trade.tokenIn.toUpperCase() === "SUSDT" || trade.tokenIn.toUpperCase() === "USDA" ? 1 : 0));
          extraData.amountOutUsd = trade.amountOut * (priceOut || (trade.tokenOut.toUpperCase() === "SUSDT" || trade.tokenOut.toUpperCase() === "USDA" ? 1 : 0));
        }
      } catch {
        // ignore errors
      }
    }

    return this.prisma.trade.update({
      where: { id: tradeId },
      data: {
        status,
        txId,
        errorMessage,
        ...extraData,
      },
    });
  }

  async findPendingTrades() {
    return this.prisma.trade.findMany({
      where: { status: { in: ["PENDING", "BROADCAST"] } },
    });
  }

  async hasPendingTradesForWallet(walletId: number): Promise<boolean> {
    const count = await this.prisma.trade.count({
      where: {
        walletId,
        status: { in: ["PENDING", "BROADCAST"] },
      },
    });
    return count > 0;
  }

  async getDailyTradesSince(userId: number, since: Date) {
    return this.prisma.trade.findMany({
      where: { userId, createdAt: { gte: since } },
    });
  }

  // ---------- MarketMakingGrid ----------

  async findGrid(walletId: number, tokenPair: string) {
    return this.prisma.marketMakingGrid.findUnique({
      where: { walletId_tokenPair: { walletId, tokenPair } },
    });
  }

  async findGridsByWallet(walletId: number) {
    return this.prisma.marketMakingGrid.findMany({ where: { walletId } });
  }

  async upsertGrid(data: {
    userId: number;
    walletId: number;
    tokenPair: string;
    midPrice: number;
    gridLevels?: number;
    spreadBps: number;
  }) {
    return this.prisma.marketMakingGrid.upsert({
      where: {
        walletId_tokenPair: {
          walletId: data.walletId,
          tokenPair: data.tokenPair,
        },
      },
      create: {
        userId: data.userId,
        walletId: data.walletId,
        tokenPair: data.tokenPair,
        midPrice: data.midPrice,
        gridLevels: data.gridLevels ?? 5,
        spreadBps: data.spreadBps,
      },
      update: {
        midPrice: data.midPrice,
        spreadBps: data.spreadBps,
        gridLevels: data.gridLevels,
      },
    });
  }

  async deleteGrid(gridId: number) {
    return this.prisma.marketMakingGrid.delete({ where: { id: gridId } });
  }

  // ---------- AIRecommendation ----------

  async createAIRecommendation(data: {
    userId: number;
    context: string;
    inputHash: string;
    modelProvider: string;
    modelName: string;
    promptTokens: number;
    completionTokens: number;
    recommendation: Prisma.InputJsonValue;
  }) {
    return this.prisma.aIRecommendation.create({
      data: data as Prisma.AIRecommendationCreateInput,
    });
  }

  async markRecommendationActed(id: number) {
    return this.prisma.aIRecommendation.update({
      where: { id },
      data: { actedUpon: true },
    });
  }

  // ---------- RefreshToken ----------

  async createRefreshToken(userId: number, tokenHash: string, expiresAt: Date) {
    return this.prisma.refreshToken.create({
      data: { userId, tokenHash, expiresAt },
    });
  }

  async findRefreshToken(tokenHash: string) {
    return this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });
  }

  async revokeRefreshToken(id: number) {
    return this.prisma.refreshToken.update({
      where: { id },
      data: { revoked: true },
    });
  }

  async revokeAllRefreshTokens(userId: number) {
    return this.prisma.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true },
    });
  }

  // ---------- BlockedToken ----------

  async getBlockedTokens(userId: number) {
    return this.prisma.blockedToken.findMany({
      where: { userId },
    });
  }

  async blockToken(userId: number, contractId: string, symbol: string) {
    return this.prisma.blockedToken.create({
      data: { userId, contractId, symbol },
    });
  }

  async unblockToken(userId: number, contractId: string) {
    return this.prisma.blockedToken.deleteMany({
      where: { userId, contractId },
    });
  }

  // ---------- Email / User ----------

  async findUserByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async createEmailUser(data: {
    email: string;
    passwordHash: string;
    username?: string;
  }) {
    return this.prisma.user.create({
      data: {
        email: data.email,
        passwordHash: data.passwordHash,
        username: data.username,
      },
    });
  }

  async markEmailVerified(userId: number) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { emailVerified: true },
    });
  }

  async linkTelegramToUser(userId: number, telegramId: bigint) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { telegramId },
    });
  }

  async mergeTelegramAndEmailUsers(emailUserId: number, telegramUserId: number, telegramId: bigint) {
    const telegramUser = await this.prisma.user.findUnique({ where: { id: telegramUserId } });
    const emailUser = await this.prisma.user.findUnique({ where: { id: emailUserId } });
    if (!telegramUser || !emailUser) return;

    await this.prisma.$transaction(async (tx) => {
      // 1. Handle unique constraints in BlockedToken
      const telegramBlocked = await tx.blockedToken.findMany({ where: { userId: telegramUserId } });
      const emailBlocked = await tx.blockedToken.findMany({ where: { userId: emailUserId } });
      const emailBlockedSymbols = new Set(emailBlocked.map(b => b.contractId));
      const duplicates = telegramBlocked.filter(b => emailBlockedSymbols.has(b.contractId));
      if (duplicates.length > 0) {
        await tx.blockedToken.deleteMany({
          where: { id: { in: duplicates.map(d => d.id) } }
        });
      }

      // 2. Handle unique constraints in TradeSettings
      const emailSettings = await tx.tradeSettings.findFirst({ where: { userId: emailUserId } });
      if (emailSettings) {
        await tx.tradeSettings.deleteMany({ where: { userId: telegramUserId } });
      }

      // 3. Merge points
      const totalPoints = emailUser.points + telegramUser.points;

      // 4. Update the email user with telegram details
      await tx.user.update({
        where: { id: emailUserId },
        data: {
          telegramId,
          username: emailUser.username || telegramUser.username,
          points: totalPoints,
        },
      });

      // 5. Update user relation for all child records
      await tx.wallet.updateMany({ where: { userId: telegramUserId }, data: { userId: emailUserId } });
      await tx.tradeSettings.updateMany({ where: { userId: telegramUserId }, data: { userId: emailUserId } });
      await tx.trade.updateMany({ where: { userId: telegramUserId }, data: { userId: emailUserId } });
      await tx.marketMakingGrid.updateMany({ where: { userId: telegramUserId }, data: { userId: emailUserId } });
      await tx.aIRecommendation.updateMany({ where: { userId: telegramUserId }, data: { userId: emailUserId } });
      await tx.refreshToken.updateMany({ where: { userId: telegramUserId }, data: { userId: emailUserId } });
      await tx.emailToken.updateMany({ where: { userId: telegramUserId }, data: { userId: emailUserId } });
      await tx.limitOrder.updateMany({ where: { userId: telegramUserId }, data: { userId: emailUserId } });
      await tx.blockedToken.updateMany({ where: { userId: telegramUserId }, data: { userId: emailUserId } });
      await tx.tradingStrategy.updateMany({ where: { userId: telegramUserId }, data: { userId: emailUserId } });
      await tx.tradeAgent.updateMany({ where: { userId: telegramUserId }, data: { userId: emailUserId } });

      // 6. Delete the temporary telegram-only user record
      await tx.user.delete({ where: { id: telegramUserId } });
    });
  }

  async linkEmailToUser(userId: number, email: string, passwordHash: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { email, passwordHash },
    });
  }

  async updateUserPassword(userId: number, passwordHash: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
  }

  async unlinkTelegram(userId: number) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { telegramId: null },
    });
  }

  // ---------- EmailToken ----------

  async createEmailToken(userId: number, type: string, expiresInMs: number) {
    const token = crypto.randomBytes(32).toString("hex");
    return this.prisma.emailToken.create({
      data: {
        userId,
        token,
        type,
        expiresAt: new Date(Date.now() + expiresInMs),
      },
    });
  }

  async findEmailToken(token: string) {
    return this.prisma.emailToken.findUnique({ where: { token } });
  }

  async consumeEmailToken(tokenId: number) {
    return this.prisma.emailToken.update({
      where: { id: tokenId },
      data: { used: true },
    });
  }

  // ---------- Admin / Stats ----------

  async getStats() {
    const [totalUsers, totalWallets, totalTrades] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.wallet.count(),
      this.prisma.trade.count(),
    ]);
    return { totalUsers, totalWallets, totalTrades };
  }

  async getAllUsers(page: number, limit: number) {
    return this.prisma.user.findMany({
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        telegramId: true,
        username: true,
        email: true,
        points: true,
        isActive: true,
        isAdmin: true,
        createdAt: true,
        _count: { select: { wallets: true, trades: true } },
      },
    });
  }

  async setUserActive(userId: number, active: boolean) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { isActive: active },
    });
  }

  async getUsersWithTelegram() {
    return this.prisma.user.findMany({
      where: { telegramId: { not: null }, isActive: true },
      select: { id: true, telegramId: true },
    });
  }

  async createAuditLog(data: { userId: number; action: string; details: string; ipAddress?: string }) {
    return this.prisma.auditLog.create({
      data: {
        userId: data.userId,
        action: data.action,
        details: data.details,
        ipAddress: data.ipAddress,
      },
    });
  }
}
