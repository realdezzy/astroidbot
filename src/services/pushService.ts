import webpush from "web-push";
import { ConfigManager } from "../config.js";
import { DatabaseService } from "./db.js";
import { logger } from "../utils/logger.js";

export class PushService {
  private static instance: PushService;
  private publicKey: string = "";
  private privateKey: string = "";
  private subject: string = "mailto:admin@astroidbot.io";

  private constructor() {
    this.initVapidKeys();
  }

  static getInstance(): PushService {
    if (!PushService.instance) {
      PushService.instance = new PushService();
    }
    return PushService.instance;
  }

  private initVapidKeys(): void {
    const config = ConfigManager.getInstance().config;
    this.subject = config.VAPID_SUBJECT || "mailto:admin@astroidbot.io";

    if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
      this.publicKey = config.VAPID_PUBLIC_KEY;
      this.privateKey = config.VAPID_PRIVATE_KEY;
    } else {
      // Auto-generate VAPID keypair for dev/testing if not supplied
      const keys = webpush.generateVAPIDKeys();
      this.publicKey = keys.publicKey;
      this.privateKey = keys.privateKey;
      logger.info("Auto-generated VAPID keys for Web Push", { publicKey: this.publicKey });
    }

    webpush.setVapidDetails(this.subject, this.publicKey, this.privateKey);
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  async subscribe(
    userId: number,
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    userAgent?: string
  ): Promise<void> {
    const db = DatabaseService.getInstance();
    await db.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      update: {
        userId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent,
      },
      create: {
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent,
      },
    });
    logger.info("Push subscription saved", { userId, endpoint: sub.endpoint.slice(0, 30) });
  }

  async unsubscribe(userId: number, endpoint: string): Promise<void> {
    const db = DatabaseService.getInstance();
    await db.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
    logger.info("Push subscription removed", { userId });
  }

  async sendPushNotification(
    userId: number,
    payload: { title: string; message: string; type?: string; url?: string }
  ): Promise<void> {
    const db = DatabaseService.getInstance();
    const subscriptions = await db.prisma.pushSubscription.findMany({
      where: { userId },
    });

    if (subscriptions.length === 0) return;

    const body = JSON.stringify({
      title: payload.title,
      body: payload.message,
      type: payload.type || "INFO",
      url: payload.url || "/portfolio",
      timestamp: Date.now(),
    });

    await Promise.all(
      subscriptions.map(async (sub) => {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        };

        try {
          await webpush.sendNotification(pushSubscription, body);
        } catch (err: unknown) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          logger.warn("Push notification delivery failed", {
            userId,
            endpoint: sub.endpoint.slice(0, 30),
            statusCode,
          });

          // HTTP 410 (Gone) or HTTP 404 (Not Found) means subscription expired or revoked
          if (statusCode === 410 || statusCode === 404) {
            await db.prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
          }
        }
      })
    );
  }
}
