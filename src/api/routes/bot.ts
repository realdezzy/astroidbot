import { Router } from "express";
import { authenticate, requireAdmin } from "../middleware/auth.js";
import { BotController } from "../controllers/botController.js";

const router = Router();

router.get("/status", authenticate, BotController.getStatus);
router.post("/halt", authenticate, requireAdmin, BotController.haltBot);
router.post("/resume", authenticate, requireAdmin, BotController.resumeBot);

export default router;
