import { DatabaseService } from "../db.js";
import { TransactionService } from "../transaction.js";
import { ConfigManager } from "../../config.js";
import { getTokensMeta } from "@velarprotocol/velar-sdk";
import { logger } from "../../utils/logger.js";
import { createSTXPostCondition, FungibleConditionCode } from "@stacks/transactions";

async function getTokenDetails(symbol: string) {
  const tokens = await getTokensMeta();
  return tokens.find(t => t.symbol.toUpperCase() === symbol.toUpperCase());
}


export class PerpService {
  private static instance: PerpService;

  private constructor() {
  }

  static getInstance(): PerpService {
    if (!PerpService.instance) {
      PerpService.instance = new PerpService();
    }
    return PerpService.instance;
  }

  async openPosition(
    userId: number,
    walletId: number,
    market: string, 
    direction: "LONG" | "SHORT",
    margin: number, 
    leverage: number 
  ) {
    const db = DatabaseService.getInstance();
    const wallet = await db.findWalletById(walletId);
    if (!wallet) throw new Error("Wallet not found");
    if (wallet.userId !== userId) throw new Error("Unauthorized wallet access");

    const symbol = market.split("-")[0] || market;
    let entryPrice = 2.0;
    try {
      const details = await getTokenDetails(symbol);
      if (details && details.price) {
        entryPrice = Number(details.price);
      }
    } catch (err) {
      logger.warn(`Failed to fetch Velar price for ${symbol}, using fallback`, { error: err });
    }

    const marginMaintenance = 0.025;
    const liquidationPrice = direction === "LONG"
      ? entryPrice * (1 - 1 / leverage) / (1 - marginMaintenance)
      : entryPrice * (1 + 1 / leverage) / (1 + marginMaintenance);

    const size = margin * leverage;

    const config = ConfigManager.getInstance().config;
    const contractAddress = config.VELAR_PERP_CONTRACT_ADDRESS;
    const contractName = config.VELAR_PERP_CONTRACT_NAME;
    const functionName = "open-position";

    const functionArgs = [
      `'${symbol}`,
      `'${direction}`,
      `u${Math.floor(leverage)}`,
      `u${Math.floor(margin * 1000000)}`
    ];

    const txService = TransactionService.getInstance();
    const action = {
      tokenIn: "STX",
      tokenOut: symbol,
      amountIn: margin,
      direction: direction === "LONG" ? "BUY" as const : "SELL" as const,
      reason: `Open perp leverage position ${leverage}x ${direction} on ${market}`
    };

    const txFee = 100_000n;
    const stxLimit = BigInt(Math.floor(margin * 1_000_000)) + txFee;
    const postConditionsOverride = [
      createSTXPostCondition(wallet.address, FungibleConditionCode.LessEqual, stxLimit)
    ];

    const settings = await db.findTradeSettings(userId, "personal");
    const useGasless = settings?.useGasless ?? false;

    const result = await txService.execute(
      action,
      contractAddress,
      contractName,
      functionName,
      functionArgs,
      walletId,
      wallet.address,
      margin * 2,
      useGasless,
      postConditionsOverride
    );

    if ("error" in result) {
      throw new Error(`On-chain transaction execution failed: ${result.error}`);
    }

    const txId = result.txId;

    const position = await db.prisma.perpPosition.create({
      data: {
        userId,
        walletId,
        market,
        direction,
        size,
        leverage,
        entryPrice,
        liquidationPrice,
        margin,
        status: "OPEN",
        txId,
      },
    });

    logger.info("Perp position opened", { positionId: position.id, size, txId });
    return position;
  }

  async closePosition(userId: number, positionId: number) {
    const db = DatabaseService.getInstance();
    const position = await db.prisma.perpPosition.findUnique({
      where: { id: positionId }
    });

    if (!position) throw new Error("Position not found");
    if (position.userId !== userId) throw new Error("Unauthorized access");
    if (position.status !== "OPEN") throw new Error("Position already closed or liquidated");

    const wallet = await db.findWalletById(position.walletId);
    if (!wallet) throw new Error("Wallet not found");

    const symbol = position.market.split("-")[0] || position.market;
    let currentPrice = 2.0;
    try {
      const details = await getTokenDetails(symbol);
      if (details && details.price) {
        currentPrice = Number(details.price);
      }
    } catch (err) {
      logger.warn(`Failed to fetch Velar price for ${symbol}, using fallback`, { error: err });
    }

    const isLiquidated = position.direction === "LONG"
      ? currentPrice <= position.liquidationPrice
      : currentPrice >= position.liquidationPrice;

    const config = ConfigManager.getInstance().config;
    const contractAddress = config.VELAR_PERP_CONTRACT_ADDRESS;
    const contractName = config.VELAR_PERP_CONTRACT_NAME;
    const functionName = "close-position";
    const functionArgs = [
      `u${positionId}`
    ];

    const txService = TransactionService.getInstance();
    const action = {
      tokenIn: symbol,
      tokenOut: "STX",
      amountIn: position.size,
      direction: position.direction === "LONG" ? "SELL" as const : "BUY" as const,
      reason: `Close perp leverage position ${positionId} on ${position.market}`
    };

    const txFee = 100_000n;
    const postConditionsOverride = [
      createSTXPostCondition(wallet.address, FungibleConditionCode.LessEqual, txFee)
    ];

    const settings = await db.findTradeSettings(userId, "personal");
    const useGasless = settings?.useGasless ?? false;

    const result = await txService.execute(
      action,
      contractAddress,
      contractName,
      functionName,
      functionArgs,
      position.walletId,
      wallet.address,
      position.size,
      useGasless,
      postConditionsOverride
    );

    if ("error" in result) {
      throw new Error(`On-chain transaction execution failed: ${result.error}`);
    }

    const updated = await db.prisma.perpPosition.update({
      where: { id: positionId },
      data: {
        status: isLiquidated ? "LIQUIDATED" : "CLOSED",
        updatedAt: new Date(),
      }
    });

    logger.info("Perp position closed", { positionId, status: updated.status });
    return updated;
  }

  async getPosition(positionId: number) {
    const db = DatabaseService.getInstance();
    return db.prisma.perpPosition.findUnique({
      where: { id: positionId }
    });
  }

  async getUserPositions(userId: number) {
    const db = DatabaseService.getInstance();
    return db.prisma.perpPosition.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" }
    });
  }
}
