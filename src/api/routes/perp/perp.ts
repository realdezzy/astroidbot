import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { PerpController } from "../../controllers/perpController.js";

const router = Router();

const openPositionSchema = z.object({
  walletId: z.number().int(),
  market: z.string().min(1),
  direction: z.enum(["LONG", "SHORT"]),
  margin: z.number().positive(),
  leverage: z.number().positive(),
});

router.get("/positions", authenticate, PerpController.getPositions);
router.post("/positions", authenticate, validateBody(openPositionSchema), PerpController.openPosition);
router.post("/positions/:id/close", authenticate, PerpController.closePosition);

export default router;
