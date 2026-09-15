import { describe, expect, it, vi } from "vitest";
import { renderScreen } from "../../src/bot/ui/render.js";
import { clearFlow, initialSession } from "../../src/bot/session.js";

describe("Telegram screen renderer", () => {
  it("replies when opened from a slash command", async () => {
    const reply = vi.fn().mockResolvedValue({});
    const editMessageText = vi.fn();
    await renderScreen({ reply, editMessageText } as never, { text: "Portfolio" });
    expect(reply).toHaveBeenCalledWith("Portfolio", {});
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it("edits callback navigation in place", async () => {
    const reply = vi.fn();
    const editMessageText = vi.fn().mockResolvedValue({});
    await renderScreen({ callbackQuery: { data: "screen:portfolio" }, reply, editMessageText } as never, { text: "Portfolio" });
    expect(editMessageText).toHaveBeenCalledWith("Portfolio", {});
    expect(reply).not.toHaveBeenCalled();
  });

  it("falls back to a new message when an old callback message cannot be edited", async () => {
    const reply = vi.fn().mockResolvedValue({});
    const editMessageText = vi.fn().mockRejectedValue(new Error("message can't be edited"));
    await renderScreen({ callbackQuery: { data: "screen:portfolio" }, reply, editMessageText } as never, { text: "Portfolio" });
    expect(reply).toHaveBeenCalledWith("Portfolio", {});
  });
});

describe("Telegram flow state", () => {
  it("clears every transient flow field while retaining user context", () => {
    const session = initialSession();
    session.activeChainId = "base:mainnet";
    session.chatHistory = [{ role: "user", content: "hello" }];
    session.waitingFor = "trade_amount_custom";
    session.tradeAmount = 12;
    session.tradeQuote = { quotedAt: 1, provider: "dex", tokenIn: "ETH", tokenOut: "USDC", amountIn: 1, amountOut: 2 };
    session.tempStrategyWalletIds = [99];

    clearFlow(session);

    expect(session.waitingFor).toBeNull();
    expect(session.tradeAmount).toBeUndefined();
    expect(session.tradeQuote).toBeUndefined();
    expect(session.tempStrategyWalletIds).toBeUndefined();
    expect(session.activeChainId).toBe("base:mainnet");
    expect(session.chatHistory).toHaveLength(1);
  });
});
