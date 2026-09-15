import crypto from "node:crypto";
import { z } from "zod";
import { DatabaseService } from "../db.js";
import { QueueManager } from "../queue.js";

const tradePayloadSchema = z.object({
  walletId: z.number().int().positive(), chainId: z.string().min(1),
  tokenIn: z.string().min(1), tokenOut: z.string().min(1),
  amountIn: z.number().positive().finite(), direction: z.enum(["BUY", "SELL"]),
});
const tradeQuoteSchema = z.object({
  provider: z.string().min(1), amountOut: z.number().nonnegative().finite(),
  priceImpact: z.number().finite(), feeAmount: z.number().nonnegative().finite(),
  feeBps: z.number().int().nonnegative(),
});

export type TradeActionPayload = z.infer<typeof tradePayloadSchema>;
export type TradeQuoteSnapshot = z.infer<typeof tradeQuoteSchema>;

export class PendingActionService {
  private static instance: PendingActionService;
  static getInstance(): PendingActionService {
    if (!this.instance) this.instance = new PendingActionService();
    return this.instance;
  }

  async prepareTrade(input: { userId: number; payload: TradeActionPayload;
    quote: TradeQuoteSnapshot; source: "telegram" | "mini_app" | "web" | "notification"; expiresAt: Date }) {
    const payload = tradePayloadSchema.parse(input.payload);
    const quote = tradeQuoteSchema.parse(input.quote);
    const db = DatabaseService.getInstance();
    const wallet = await db.findWalletById(payload.walletId);
    if (!wallet || wallet.userId !== input.userId || wallet.chain !== payload.chainId) {
      throw new Error("Wallet is unavailable for this action");
    }
    return db.prisma.pendingAction.create({ data: {
      userId: input.userId, kind: "TRADE", payload, quoteSnapshot: quote,
      status: "QUOTED", source: input.source, expiresAt: input.expiresAt,
      idempotencyKey: crypto.randomUUID(),
    }});
  }

  async confirmTrade(actionId: string, userId: number): Promise<void> {
    const db = DatabaseService.getInstance();
    const action = await db.prisma.pendingAction.findFirst({ where: { id: actionId, userId, kind: "TRADE" } });
    if (!action) throw new Error("Trade approval was not found");
    if (action.status !== "QUOTED") throw new Error("Trade approval was already used");
    if (action.expiresAt.getTime() <= Date.now()) {
      await db.prisma.pendingAction.updateMany({ where: { id: action.id, userId, status: "QUOTED" }, data: { status: "EXPIRED" } });
      throw new Error("Trade quote has expired");
    }
    const payload = tradePayloadSchema.parse(action.payload);
    const wallet = await db.findWalletById(payload.walletId);
    if (!wallet || wallet.userId !== userId || wallet.chain !== payload.chainId) throw new Error("Wallet is unavailable for this action");

    const claimed = await db.prisma.pendingAction.updateMany({
      where: { id: action.id, userId, status: "QUOTED", expiresAt: { gt: new Date() } },
      data: { status: "CONFIRMED", confirmedAt: new Date() },
    });
    if (claimed.count !== 1) throw new Error("Trade approval was already used or expired");
    try {
      await QueueManager.getInstance().enqueueTrade({
        walletId: wallet.id, userId, senderAddress: wallet.address,
        tokenIn: payload.tokenIn, tokenOut: payload.tokenOut, amountIn: payload.amountIn,
        direction: payload.direction, reason: `Approved action ${action.id}`,
      }, action.id);
    } catch (error) {
      await db.prisma.pendingAction.updateMany({ where: { id: action.id, userId, status: "CONFIRMED" }, data: { status: "QUOTED", confirmedAt: null } });
      throw error;
    }
  }

  async cancel(actionId: string, userId: number): Promise<boolean> {
    const result = await DatabaseService.getInstance().prisma.pendingAction.updateMany({
      where: { id: actionId, userId, status: { in: ["DRAFT", "QUOTED"] } }, data: { status: "CANCELLED" },
    });
    return result.count === 1;
  }
}
