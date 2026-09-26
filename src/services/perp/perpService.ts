import { DatabaseService } from "../db.js";
import { ConfigManager } from "../../config.js";
import { getTokensMeta } from "@velarprotocol/velar-sdk";
import { logger } from "../../utils/logger.js";
import { FungibleConditionCode } from "@stacks/transactions";
import { createSTXPostCondition } from "../transaction.js";
import { executeSwapPayload } from "../chains/executeSwap.js";
import { walletChainId } from "../chains/walletChain.js";
import { resolveTradeSettings } from "../tradeSettings.js";
import { RiskManager } from "../riskManager.js";
import { PortfolioManager } from "../portfolio.js";
import { DEXRegistry } from "../dex/dexRegistry.js";
import type { TransactionPayload } from "../../types.js";

/**
 * The mark price for a perp market, or a thrown error.
 *
 * Both call sites used to declare `let price = 2.0` and overwrite it from Velar
 * when that worked, logging a warning otherwise. On the close path the result
 * went straight into the liquidation comparison, so a failed price call decided
 * — either way — whether a leveraged position was liquidated, against a number
 * nobody had observed. $2.00 is also a plausible STX price, which is why it
 * survived review.
 *
 * Leverage makes this the least forgiving place on the platform to guess, so
 * this refuses instead. The same call is made twice elsewhere in the codebase
 * ("stop fabricating market data"; "an unpriceable token is not a token worth
 * zero") and the reasoning is identical: refusing costs an error the caller can
 * show, guessing costs the position.
 */
async function requireMarkPrice(market: string): Promise<number> {
  const symbol = market.split("-")[0] || market;

  let tokens: Awaited<ReturnType<typeof getTokensMeta>>;
  try {
    tokens = await getTokensMeta();
  } catch (error) {
    throw new Error(
      `Cannot determine a price for ${symbol}: the price feed is unreachable ` +
      `(${error instanceof Error ? error.message : String(error)})`
    );
  }

  const details = tokens.find((t) => t.symbol?.toUpperCase() === symbol.toUpperCase());
  const price = details?.price != null ? Number(details.price) : NaN;

  // A market absent from the feed and a feed that threw are the same condition
  // — no price — and a zero or NaN is worse than either, because it would sail
  // through arithmetic and produce a liquidation price of 0.
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Cannot determine a price for ${symbol}: not quoted by the price feed`);
  }

  return price;
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

    const chainId = walletChainId(wallet);
    const symbol = market.split("-")[0] || market;
    const entryPrice = await requireMarkPrice(market);

    const marginMaintenance = 0.025;
    const liquidationPrice = direction === "LONG"
      ? entryPrice * (1 - 1 / leverage) / (1 - marginMaintenance)
      : entryPrice * (1 + 1 / leverage) / (1 + marginMaintenance);

    const size = margin * leverage;

    const settings = await resolveTradeSettings(userId, "personal", chainId);

    // Leverage was the one product here with no exposure ceiling: there was no
    // RiskManager call anywhere in this module, so `maxPositionPct` and
    // `dailyLossLimit` bound spot trades and not this.
    //
    // Sized on `size`, not `margin`. The margin is what leaves the wallet; the
    // notional is the exposure the limits exist to bound, and checking the
    // margin would let a user at 5x take five times the position their cap
    // allows while the check reported compliance.
    const tokens = await DEXRegistry.getInstance().getSwappableTokens(false, chainId);
    const balances = await PortfolioManager.getInstance().fetchBalances(
      wallet.address, tokens, userId, true, chainId
    );
    const risk = await RiskManager.getInstance().evaluateTrade(
      userId,
      {
        tokenIn: "STX",
        tokenOut: symbol,
        amountIn: size,
        direction: direction === "LONG" ? "BUY" : "SELL",
        reason: `Open perp ${leverage}x ${direction} on ${market}`,
      },
      balances,
      {
        slippageBps: settings.slippageBps,
        maxPositionPct: settings.maxPositionPct,
        dailyLossLimit: settings.dailyLossLimit,
      }
    );
    if (!risk.approved) {
      throw new Error(risk.reason ?? "Trade rejected by risk limits");
    }

    const config = ConfigManager.getInstance().config;
    const txFee = 100_000n;
    const stxLimit = BigInt(Math.floor(margin * 1_000_000)) + txFee;

    const payload: TransactionPayload = {
      kind: "stacks",
      contractAddress: config.VELAR_PERP_CONTRACT_ADDRESS,
      contractName: config.VELAR_PERP_CONTRACT_NAME,
      functionName: "open-position",
      functionArgs: [
        `'${symbol}`,
        `'${direction}`,
        `u${Math.floor(leverage)}`,
        `u${Math.floor(margin * 1000000)}`,
      ],
      // The cap on how much STX can leave the wallet. It rides on the payload
      // now rather than being passed beside it, which is what lets this route
      // through the shared dispatch point without losing it.
      postConditions: [
        createSTXPostCondition(wallet.address, FungibleConditionCode.LessEqual, stxLimit),
      ],
    };

    const result = await executeSwapPayload(payload, {
      action: {
        tokenIn: "STX",
        tokenOut: symbol,
        amountIn: margin,
        direction: direction === "LONG" ? "BUY" : "SELL",
        reason: `Open perp leverage position ${leverage}x ${direction} on ${market}`,
      },
      walletId,
      senderAddress: wallet.address,
      maxOutbound: margin * 2,
      useGasless: settings.useGasless,
      chainId,
    });

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

    const chainId = walletChainId(wallet);
    const symbol = position.market.split("-")[0] || position.market;

    // Refuses rather than guessing, and here the refusal is the whole point:
    // this number decides `isLiquidated`.
    const currentPrice = await requireMarkPrice(position.market);

    const isLiquidated = position.direction === "LONG"
      ? currentPrice <= position.liquidationPrice
      : currentPrice >= position.liquidationPrice;

    // Deliberately no RiskManager gate on the way out. Closing reduces
    // exposure, so gating it on the same limits that would block an open would
    // trap a user in a position exactly when they are over their cap — which is
    // when they most need to be able to leave.
    const settings = await resolveTradeSettings(userId, "personal", chainId);

    const config = ConfigManager.getInstance().config;
    const txFee = 100_000n;

    const payload: TransactionPayload = {
      kind: "stacks",
      contractAddress: config.VELAR_PERP_CONTRACT_ADDRESS,
      contractName: config.VELAR_PERP_CONTRACT_NAME,
      functionName: "close-position",
      functionArgs: [`u${positionId}`],
      postConditions: [
        createSTXPostCondition(wallet.address, FungibleConditionCode.LessEqual, txFee),
      ],
    };

    const result = await executeSwapPayload(payload, {
      action: {
        tokenIn: symbol,
        tokenOut: "STX",
        amountIn: position.size,
        direction: position.direction === "LONG" ? "SELL" : "BUY",
        reason: `Close perp leverage position ${positionId} on ${position.market}`,
      },
      walletId: position.walletId,
      senderAddress: wallet.address,
      maxOutbound: position.size,
      useGasless: settings.useGasless,
      chainId,
    });

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

  async calculateFundingRate(market: string, indexPrice: number, markPrice: number): Promise<{ rateBps: number; isPayLong: boolean }> {
    if (indexPrice <= 0) return { rateBps: 0, isPayLong: true };
    const premium = (markPrice - indexPrice) / indexPrice;
    const rateBps = Math.round(premium * 10000);
    return {
      rateBps,
      isPayLong: rateBps > 0,
    };
  }
}
