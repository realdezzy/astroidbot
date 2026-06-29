import { QueueManager, QUEUES } from "./queue.js";
import { DatabaseService } from "./db.js";
import { TelegramService } from "./telegram.js";
import { WebSocketManager } from "../api/websocket.js";
import { logger } from "../utils/logger.js";
import type { Job } from "bullmq";

export interface NotificationPayload {
  userId: number;
  title: string;
  message: string;
  type: "INFO" | "WARNING" | "ERROR" | "SUCCESS";
}

export class NotificationService {
  private static instance: NotificationService;

  private constructor() {}

  static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  async send(data: NotificationPayload): Promise<void> {
    try {
      await QueueManager.getInstance().getQueue(QUEUES.NOTIFICATION).add("send-notification", data);
      logger.debug("Notification job enqueued", { userId: data.userId, title: data.title });
    } catch (err) {
      logger.error("Failed to enqueue notification, running synchronously", { error: err, data });
      // Fallback: execute synchronously if queue fails
      await this.processNotification(data);
    }
  }

  async processNotification(data: NotificationPayload): Promise<void> {
    try {
      const db = DatabaseService.getInstance();
      const notification = await db.prisma.notification.create({
        data: {
          userId: data.userId,
          title: data.title,
          message: data.message,
          type: data.type,
        },
      });

      // Broadcast via WS
      WebSocketManager.getInstance().broadcastToUser(data.userId, {
        type: "notification",
        payload: notification,
      });

      // Send via Telegram
      const telegram = TelegramService.getInstance();
      if (telegram.isEnabled()) {
        await telegram.sendAlert(data.userId, `[${data.type}] *${data.title}*\n${data.message}`);
      }
    } catch (err) {
      logger.error("Failed to process notification", { error: err, data });
    }
  }
}

// Worker handler function
export async function processNotificationJob(job: Job<NotificationPayload>): Promise<void> {
  const service = NotificationService.getInstance();
  await service.processNotification(job.data);
}
