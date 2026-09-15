import { beforeEach, describe, expect, it, vi } from "vitest";

const wallet = { id: 3, userId: 7, chain: "base:mainnet", address: "0xabc" };
const action = {
  id: "8a8d736e-24f7-4998-b40d-dfa9db0fd501", userId: 7, kind: "TRADE",
  status: "QUOTED", expiresAt: new Date(Date.now() + 60_000),
  payload: { walletId: 3, chainId: "base:mainnet", tokenIn: "USDC", tokenOut: "ETH", amountIn: 10, direction: "BUY" },
};
const prisma = {
  pendingAction: {
    create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(),
  },
};
const findWalletById = vi.fn();
const enqueueTrade = vi.fn();

vi.mock("../../src/services/db.js", () => ({
  DatabaseService: { getInstance: () => ({ prisma, findWalletById }) },
}));
vi.mock("../../src/services/queue.js", () => ({
  QueueManager: { getInstance: () => ({ enqueueTrade }) },
}));

const { PendingActionService } = await import("../../src/services/actions/pendingActionService.js");

describe("PendingActionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findWalletById.mockResolvedValue(wallet);
    prisma.pendingAction.findFirst.mockResolvedValue(action);
    prisma.pendingAction.updateMany.mockResolvedValue({ count: 1 });
    enqueueTrade.mockResolvedValue("job-1");
  });

  it("atomically claims and idempotently queues a confirmed trade", async () => {
    await PendingActionService.getInstance().confirmTrade(action.id, 7);
    expect(prisma.pendingAction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: action.id, userId: 7, status: "QUOTED" }),
    }));
    expect(enqueueTrade).toHaveBeenCalledWith(expect.objectContaining({
      walletId: 3, tokenIn: "USDC", tokenOut: "ETH", amountIn: 10,
    }), action.id);
  });

  it("does not queue when another confirmation already claimed the action", async () => {
    prisma.pendingAction.updateMany.mockResolvedValue({ count: 0 });
    await expect(PendingActionService.getInstance().confirmTrade(action.id, 7)).rejects.toThrow(/already used or expired/);
    expect(enqueueTrade).not.toHaveBeenCalled();
  });

  it("rejects a wallet that no longer belongs to the user", async () => {
    findWalletById.mockResolvedValue({ ...wallet, userId: 9 });
    await expect(PendingActionService.getInstance().confirmTrade(action.id, 7)).rejects.toThrow(/Wallet is unavailable/);
    expect(enqueueTrade).not.toHaveBeenCalled();
  });
});
