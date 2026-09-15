import type { Api, RawApi } from "grammy";
import { ConfigManager } from "../config.js";
import { logger } from "../utils/logger.js";
import { DatabaseService } from "./db.js";

export type TelegramTopicPurpose = "ASSISTANT" | "TRADES" | "AGENTS" | "RISK";
const TOPIC_NAMES: Record<TelegramTopicPurpose, string> = {
  ASSISTANT: "🤖 Astroid AI", TRADES: "📈 Trades & Orders",
  AGENTS: "🧠 Agent Reports", RISK: "🛡 Risk Alerts",
};

export class TelegramTopicService {
  static async resolve(api: Api<RawApi>, userId: number, chatId: number, purpose: TelegramTopicPurpose): Promise<number | undefined> {
    if (!ConfigManager.getInstance().config.TELEGRAM_TOPICS_ENABLED) return undefined;
    const db = DatabaseService.getInstance();
    const existing = await db.prisma.telegramTopic.findUnique({ where: { userId_purpose: { userId, purpose } } });
    if (existing) return existing.threadId;
    try {
      const topic = await api.createForumTopic(chatId, TOPIC_NAMES[purpose]);
      const stored = await db.prisma.telegramTopic.upsert({
        where: { userId_purpose: { userId, purpose } },
        update: { threadId: topic.message_thread_id },
        create: { userId, purpose, threadId: topic.message_thread_id },
      });
      return stored.threadId;
    } catch (error) {
      logger.warn("Telegram topic unavailable; using General", {
        userId, purpose, error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  static async forget(userId: number, purpose: TelegramTopicPurpose): Promise<void> {
    await DatabaseService.getInstance().prisma.telegramTopic.deleteMany({ where: { userId, purpose } });
  }
}
