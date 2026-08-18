import type { Request, Response } from "express";
import { PushService } from "../../services/pushService.js";
import { logger } from "../../utils/logger.js";

export class PushController {
  static getVapidPublicKey(req: Request, res: Response): void {
    const publicKey = PushService.getInstance().getPublicKey();
    res.json({ publicKey });
  }

  static async subscribe(req: Request, res: Response): Promise<void> {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
      return;
    }

    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      res.status(400).json({ error: "Invalid subscription payload", code: "INVALID_PAYLOAD" });
      return;
    }

    try {
      const userAgent = req.headers["user-agent"];
      await PushService.getInstance().subscribe(userId, subscription, userAgent);
      res.status(201).json({ ok: true });
    } catch (error) {
      logger.error("Failed to save push subscription", { error, userId });
      res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
    }
  }

  static async unsubscribe(req: Request, res: Response): Promise<void> {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
      return;
    }

    const { endpoint } = req.body;
    if (!endpoint || typeof endpoint !== "string") {
      res.status(400).json({ error: "Missing endpoint", code: "INVALID_PAYLOAD" });
      return;
    }

    try {
      await PushService.getInstance().unsubscribe(userId, endpoint);
      res.json({ ok: true });
    } catch (error) {
      logger.error("Failed to unsubscribe push endpoint", { error, userId });
      res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
    }
  }
}
