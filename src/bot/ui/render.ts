import type { InlineKeyboard } from "grammy";
import type { BotContext } from "../../types/bot.js";

export interface ScreenView {
  text: string;
  keyboard?: InlineKeyboard;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  /** Force a new message for prompts that expect a typed response. */
  newMessage?: boolean;
}

function isMessageUnchanged(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("message is not modified");
}

/**
 * Render one Telegram view consistently from either a command or a callback.
 * Callback navigation edits the current message; slash commands and prompts
 * create a message. If Telegram can no longer edit an old message, it falls
 * back to a new one instead of silently leaving the user on a dead screen.
 */
export async function renderScreen(ctx: BotContext, view: ScreenView): Promise<void> {
  const options = {
    ...(view.parseMode === undefined ? {} : { parse_mode: view.parseMode }),
    ...(view.keyboard === undefined ? {} : { reply_markup: view.keyboard }),
  };

  if (ctx.callbackQuery && !view.newMessage) {
    try {
      await ctx.editMessageText(view.text, options);
      return;
    } catch (error) {
      if (isMessageUnchanged(error)) return;
    }
  }

  await ctx.reply(view.text, options);
}

export function markdownView(text: string, keyboard?: InlineKeyboard, newMessage = false): ScreenView {
  return { text, keyboard, parseMode: "Markdown", newMessage };
}
