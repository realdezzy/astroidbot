import { Bot, session } from "grammy";
import type { Update } from "grammy/types";
import { ConfigManager } from "../config.js";
import { logger } from "../utils/logger.js";
import { DatabaseService } from "./db.js";
import { BotStatus } from "../types.js";
import { registerRouter } from "../bot/router.js";
import type { BotContext } from "../bot/types.js";

export class TelegramService {
  private static instance: TelegramService;
  private bot: Bot<BotContext> | null = null;
  private botStatus: BotStatus = BotStatus.IDLE;
  private haltedReason: string | null = null;
  private webhookPath: string | null = null;
  private useWebhook = false;

  private constructor() {
    const token = ConfigManager.getInstance().config.TELEGRAM_BOT_TOKEN;

    if (!token) {
      logger.warn("TELEGRAM_BOT_TOKEN not set; Telegram bot disabled");
      return;
    }

    this.bot = new Bot<BotContext>(token);

    this.bot.use(
      session({
        initial: () => ({
          waitingFor: null as string | null,
          backScreen: undefined as string | undefined,
          emailToLink: undefined as string | undefined,
          tradePair: undefined as string | undefined,
          tradeDir: undefined as string | undefined,
          tradeAmount: undefined as number | string | undefined,
          tradeWalletId: undefined as number | undefined,
          tradeTokenIn: undefined as string | undefined,
          tradeTokenOut: undefined as string | undefined,
          limitPair: undefined as string | undefined,
          limitDir: undefined as string | undefined,
          limitAmount: undefined as number | string | undefined,
          limitPrice: undefined as number | string | undefined,
          tempPrivateKey: undefined as string | undefined,
          tempAddress: undefined as string | undefined,
          tempAgentName: undefined as string | undefined,
          tempAgentContext: undefined as string | undefined,
        }),
      })
    );

    registerRouter(this.bot);

    const webhookUrl = ConfigManager.getInstance().config.TELEGRAM_WEBHOOK_URL;
    this.useWebhook = !!webhookUrl;

    if (this.useWebhook && webhookUrl) {
      try {
        const parsed = new URL(webhookUrl);
        this.webhookPath = parsed.pathname;
        logger.info("Webhook configured", { url: webhookUrl, path: this.webhookPath });
      } catch {
        logger.warn("Invalid TELEGRAM_WEBHOOK_URL, falling back to polling");
        this.useWebhook = false;
      }
    }
  }

  static getInstance(): TelegramService {
    if (!TelegramService.instance) {
      TelegramService.instance = new TelegramService();
    }
    return TelegramService.instance;
  }

  async start(): Promise<void> {
    if (!this.bot) {
      logger.info("Telegram bot not configured, skipping start");
      return;
    }

    if (this.useWebhook) {
      const webhookUrl = ConfigManager.getInstance().config.TELEGRAM_WEBHOOK_URL!;

      await this.bot.init();

      await this.bot.api.setWebhook(webhookUrl, {
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      });

      const info = await this.bot.api.getWebhookInfo();
      logger.info("Telegram webhook set", {
        url: info.url,
        pending: info.pending_update_count,
      });
    } else {
      this.bot.start({
        onStart: (info) => {
          logger.info("Telegram bot started (polling)", {
            username: info.username,
          });
        },
        drop_pending_updates: true,
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.bot) return;

    if (this.useWebhook) {
      await this.bot.api.deleteWebhook({ drop_pending_updates: true });
      logger.info("Webhook deleted");
    } else {
      await this.bot.stop();
      logger.info("Telegram bot polling stopped");
    }
  }

  async handleUpdate(update: Update): Promise<void> {
    if (!this.bot) {
      throw new Error("Bot not initialized");
    }
    await this.bot.handleUpdate(update);
  }

  getWebhookPath(): string | null {
    return this.webhookPath;
  }

  isEnabled(): boolean {
    return this.bot !== null;
  }

  async sendAlert(userId: number, message: string): Promise<void> {
    if (!this.bot) return;
    try {
      const db = DatabaseService.getInstance();
      const user = await db.findUserById(userId);
      if (user) {
        await this.bot.api.sendMessage(Number(user.telegramId), message);
      }
    } catch (error) {
      logger.error("Failed to send Telegram alert", { error, userId });
    }
  }

  setStatus(status: BotStatus, reason?: string): void {
    this.botStatus = status;
    this.haltedReason = reason ?? null;
  }

  getStatus(): { status: BotStatus; reason: string | null } {
    return { status: this.botStatus, reason: this.haltedReason };
  }
}
