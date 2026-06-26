import type { Request, Response, NextFunction } from "express";
import { TelegramService } from "../../services/telegram.js";
import { WebSocketManager } from "../websocket.js";
import { BotStatus } from "../../types.js";
import { logger } from "../../utils/logger.js";
import { InternalError } from "../errors.js";

export class BotController {
  static async getStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const telegram = TelegramService.getInstance();
      const { status, reason } = telegram.getStatus();
      res.json({
        status,
        haltedReason: reason,
      });
    } catch (error) {
      logger.error("Failed to get bot status", { error });
      next(new InternalError());
    }
  }

  static async haltBot(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const telegram = TelegramService.getInstance();
      telegram.setStatus(BotStatus.HALTED, "User requested halt via API");

      WebSocketManager.getInstance().broadcastStatusChange(
        "HALTED",
        "User requested halt via API"
      );

      res.json({ status: "HALTED" });
    } catch (error) {
      logger.error("Failed to halt bot", { error });
      next(new InternalError());
    }
  }

  static async resumeBot(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const telegram = TelegramService.getInstance();
      telegram.setStatus(BotStatus.RUNNING);

      WebSocketManager.getInstance().broadcastStatusChange("RUNNING");

      res.json({ status: "RUNNING" });
    } catch (error) {
      logger.error("Failed to resume bot", { error });
      next(new InternalError());
    }
  }
}
