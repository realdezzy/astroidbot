import type { Request, Response, NextFunction } from "express";
import { PerpService } from "../../services/perp/perpService.js";
import { ValidationError } from "../errors.js";
import { logger } from "../../utils/logger.js";

export class PerpController {
  static async getPositions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const service = PerpService.getInstance();
      const positions = await service.getUserPositions(req.userId!);
      res.json(positions);
    } catch (error) {
      logger.error("Failed to fetch perp positions", { error });
      res.status(500).json({ error: "Internal server error" });
    }
  }

  static async openPosition(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { walletId, market, direction, margin, leverage } = req.body as {
        walletId: number;
        market: string;
        direction: "LONG" | "SHORT";
        margin: number;
        leverage: number;
      };

      const service = PerpService.getInstance();
      const position = await service.openPosition(
        req.userId!,
        walletId,
        market,
        direction,
        margin,
        leverage
      );

      res.status(201).json(position);
    } catch (error) {
      logger.error("Failed to open perp position", { error });
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  }

  static async closePosition(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const positionId = parseInt(String(req.params.id ?? "0"), 10);
      if (!positionId) return next(new ValidationError("Invalid position id"));

      const service = PerpService.getInstance();
      const position = await service.closePosition(req.userId!, positionId);

      res.json(position);
    } catch (error) {
      logger.error("Failed to close perp position", { error });
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  }
}
