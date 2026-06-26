import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { z } from "zod";
import { LimitOrderController } from "../controllers/limitOrderController.js";

const router = Router();

const createOrderSchema = z.object({
  walletIds: z.array(z.number().int()).min(1).optional(),
  walletId: z.number().int().optional(),
  tokenIn: z.string().min(1),
  tokenOut: z.string().min(1),
  direction: z.enum(["BUY", "SELL"]),
  targetPrice: z.number().positive(),
  amountIn: z.number().positive(),
  forceAfter: z.string().optional(),
  expiresAt: z.string().optional(),
});

router.get("/limit-orders", authenticate, LimitOrderController.getLimitOrders);
router.post("/limit-orders", authenticate, validateBody(createOrderSchema), LimitOrderController.createLimitOrder);
router.delete("/limit-orders/:id", authenticate, LimitOrderController.cancelLimitOrder);
router.post("/limit-orders/:id/cancel", authenticate, LimitOrderController.cancelLimitOrder);

export default router;
