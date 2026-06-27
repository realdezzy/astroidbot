import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { z } from "zod";
import { StrategyController } from "../controllers/strategyController.js";

const router = Router();

const createStrategySchema = z.object({
  agentId: z.number().int().positive(),
  type: z.enum(["portfolio_rebalance", "grid", "dca", "sniper", "copy", "momentum", "mean_reversion", "twap", "stop_loss_tp", "rotational", "breakout"]),
  config: z.record(z.unknown()),
  walletIds: z.array(z.number().int().positive()).min(1),
  isActive: z.boolean().optional(),
});

const updateStrategySchema = z.object({
  isActive: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  walletIds: z.array(z.number().int().positive()).optional(),
});

router.get("/", authenticate, StrategyController.getStrategies);
router.post("/", authenticate, validateBody(createStrategySchema), StrategyController.createStrategy);
router.put("/:id", authenticate, validateBody(updateStrategySchema), StrategyController.updateStrategy);
router.delete("/:id", authenticate, StrategyController.deleteStrategy);

export default router;
