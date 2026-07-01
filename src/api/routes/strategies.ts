import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { z } from "zod";
import { InternalError, NotFoundError, ValidationError } from "../errors.js";
import { STRATEGY_TYPES } from "../../../shared/strategies.js";
import { StrategyController } from "../controllers/strategyController.js";

const router = Router();

const createStrategySchema = z.object({
  agentId: z.number().int().positive(),
  type: z.enum(STRATEGY_TYPES as unknown as [string, ...string[]]),
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
router.get("/:id/detail", authenticate, StrategyController.getStrategyDetail);
router.post("/", authenticate, validateBody(createStrategySchema), StrategyController.createStrategy);
router.put("/:id", authenticate, validateBody(updateStrategySchema), StrategyController.updateStrategy);
router.delete("/:id", authenticate, StrategyController.deleteStrategy);

export default router;
