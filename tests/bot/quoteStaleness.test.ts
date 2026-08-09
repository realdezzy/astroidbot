import { describe, it, expect, beforeEach, vi } from "vitest";
import { QUOTE_TTL_MS, type BotContext, type QuotedTrade } from "../../src/types/bot.js";

/**
 * A Telegram preview is a chat message. It stays tappable for as long as the
 * chat exists, and the confirm handler enqueues a trade that is re-quoted at
 * execution time — so confirming an old preview meant agreeing to a number
 * that was no longer on offer, with only the slippage setting standing between
 * the user and a price they never saw.
 *
 * These drive the same predicate the handler uses, through the session shape
 * it reads, rather than the whole grammY callback stack.
 */

const enqueueTrade = vi.fn();
vi.mock("../../src/services/queue.js", () => ({
  QueueManager: { getInstance: () => ({ enqueueTrade }) },
}));

const tradeScreen = vi.fn();
vi.mock("../../src/bot/screens/tradeScreen.js", () => ({ tradeScreen }));

const wallet = {
  id: 1,
  userId: 7,
  address: "SP1234567890",
  name: "Main",
  chain: "stacks:mainnet",
  chainFamily: "stacks",
};

vi.mock("../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({
      findWalletById: vi.fn().mockResolvedValue(wallet),
      findUserByTelegramId: vi.fn().mockResolvedValue({ id: 7 }),
    }),
  },
}));

vi.mock("../../src/services/chains/walletChain.js", () => ({
  walletDescriptor: () => ({ nativeSymbol: "STX", stableSymbol: "USDCx" }),
}));

vi.mock("../../src/bot/context.js", () => ({
  currentUser: vi.fn().mockResolvedValue({ id: 7 }),
}));

vi.mock("../../src/bot/screens/mainMenu.js", () => ({ mainMenu: vi.fn() }));
vi.mock("../../src/bot/screens/tradesScreen.js", () => ({ tradesScreen: vi.fn() }));
vi.mock("../../src/bot/screens/ordersScreen.js", () => ({
  ordersScreen: vi.fn(),
  limitCreateScreen: vi.fn(),
}));
vi.mock("../../src/bot/chainContext.js", () => ({ activeChain: vi.fn() }));
vi.mock("../../src/services/limitOrder.js", () => ({ LimitOrderService: {} }));

const { tradeRoutes } = await import("../../src/bot/callbacks/trade.js");

function freshQuote(overrides: Partial<QuotedTrade> = {}): QuotedTrade {
  return {
    quotedAt: Date.now(),
    provider: "ALEX",
    tokenIn: "STX",
    tokenOut: "USDCx",
    amountIn: 10,
    amountOut: 25,
    ...overrides,
  };
}

function contextWith(quote: QuotedTrade | undefined) {
  return {
    session: {
      tradeWalletId: 1,
      tradeTokenIn: "STX",
      tradeTokenOut: "USDCx",
      tradeAmount: 10,
      tradeQuote: quote,
    },
    reply: vi.fn(),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  };
}

/** The handler under test, as the router would invoke it. */
const confirm = tradeRoutes.exact!.trade_confirm_elite!;

describe("Telegram quote staleness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes a quote taken moments ago", async () => {
    const ctx = contextWith(freshQuote());
    await confirm(ctx as unknown as BotContext, [], "trade_confirm_elite");

    expect(enqueueTrade).toHaveBeenCalledTimes(1);
    expect(enqueueTrade.mock.calls[0]![0]).toMatchObject({
      tokenIn: "STX",
      tokenOut: "USDCx",
      amountIn: 10,
    });
  });

  it("refuses a quote older than its validity window", async () => {
    const ctx = contextWith(freshQuote({ quotedAt: Date.now() - QUOTE_TTL_MS - 1_000 }));
    await confirm(ctx as unknown as BotContext, [], "trade_confirm_elite");

    expect(enqueueTrade).not.toHaveBeenCalled();
    // Re-quoted rather than abandoned: the intent is unambiguous, only the
    // price is out of date.
    expect(tradeScreen).toHaveBeenCalledWith(ctx, "confirm");
  });

  it("tells the user why, rather than silently reopening the screen", async () => {
    const ctx = contextWith(freshQuote({ quotedAt: Date.now() - QUOTE_TTL_MS - 5_000 }));
    await confirm(ctx as unknown as BotContext, [], "trade_confirm_elite");

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/old/i);
  });

  it("refuses a fresh quote taken for a different trade", async () => {
    // The session is mutable: back out, change the amount, and the preview on
    // screen is still the old one. An age check alone would confirm it.
    const ctx = contextWith(freshQuote({ amountIn: 999 }));
    await confirm(ctx as unknown as BotContext, [], "trade_confirm_elite");

    expect(enqueueTrade).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/changed/i);
  });

  it("refuses when there is no quote at all", async () => {
    // A Confirm tap on a preview that outlived its session.
    const ctx = contextWith(undefined);
    await confirm(ctx as unknown as BotContext, [], "trade_confirm_elite");

    expect(enqueueTrade).not.toHaveBeenCalled();
  });

  it("clears the quote after a successful confirm", async () => {
    // Leaving it set would let a second tap on the same message enqueue the
    // trade twice.
    const ctx = contextWith(freshQuote());
    await confirm(ctx as unknown as BotContext, [], "trade_confirm_elite");

    expect(ctx.session.tradeQuote).toBeUndefined();
  });
});
