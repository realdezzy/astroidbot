import { QueueManager, QUEUES } from "./queue.js";
import { DatabaseService } from "./db.js";
import { TelegramService } from "./telegram.js";
import { PushService } from "./pushService.js";
import { WebSocketManager } from "../api/websocket.js";
import { logger } from "../utils/logger.js";
import type { Job } from "bullmq";
import { AlertPreferenceService } from "./alertPreferenceService.js";

export interface NotificationPayload {
  userId: number;
  title: string;
  message: string;
  type: "INFO" | "WARNING" | "ERROR" | "SUCCESS";
  eventType?: string;
}

export class NotificationService {
  private static instance: NotificationService;
  private static readonly QUEUE_TIMEOUT_MS = 1_000;

  private constructor() {}

  static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  async send(data: NotificationPayload): Promise<void> {
    try {
      await Promise.race([
        QueueManager.getInstance().getQueue(QUEUES.NOTIFICATION).add("send-notification", data),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Notification queue enqueue timed out")), NotificationService.QUEUE_TIMEOUT_MS)
        ),
      ]);
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
          eventType: data.eventType ?? "GENERAL",
        },
      });

      // Broadcast via WS
      WebSocketManager.getInstance().broadcastToUser(data.userId, {
        type: "notification",
        payload: notification,
      });

      // Send via Telegram
      const telegram = TelegramService.getInstance();
      const preferences = AlertPreferenceService.getInstance();
      if (telegram.isEnabled() && await preferences.shouldDeliver(data.userId, "TELEGRAM", data.eventType ?? "GENERAL", data.type)) {
        const delivery = await db.prisma.notificationDelivery.create({ data: {
          notificationId: notification.id, channel: "TELEGRAM", destination: String(data.userId),
          idempotencyKey: `${notification.id}:TELEGRAM`, status: "SENDING", attemptCount: 1,
        }});
        const purpose = (data.eventType ?? "GENERAL").startsWith("AGENT") ? "AGENTS"
          : ["TRADE_STATUS", "ORDER_STATUS"].includes(data.eventType ?? "") ? "TRADES" : "RISK";
        const delivered = await telegram.sendAlert(data.userId, `[${data.type}] *${data.title}*\n${data.message}`, purpose);
        await db.prisma.notificationDelivery.update({ where: { id: delivery.id }, data: {
          status: delivered ? "DELIVERED" : "FAILED", ...(delivered ? { deliveredAt: new Date() } : { lastError: "Telegram delivery failed" }),
        }});
      }

      // Send VAPID Web Push
      if (await preferences.shouldDeliver(data.userId, "PUSH", data.eventType ?? "GENERAL", data.type)) {
        const delivery = await db.prisma.notificationDelivery.create({ data: {
          notificationId: notification.id, channel: "PUSH", destination: String(data.userId),
          idempotencyKey: `${notification.id}:PUSH`, status: "SENDING", attemptCount: 1,
        }});
        void PushService.getInstance().sendPushNotification(data.userId, {
          title: data.title, message: data.message, type: data.type,
        }).then(() => db.prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { status: "DELIVERED", deliveredAt: new Date() } }))
          .catch((error) => db.prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { status: "FAILED", lastError: error instanceof Error ? error.message : String(error) } }));
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
