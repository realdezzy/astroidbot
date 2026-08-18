import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { PushController } from "../controllers/pushController.js";

const router = Router();

router.get("/vapid-key", PushController.getVapidPublicKey);
router.post("/subscribe", authenticate, PushController.subscribe);
router.post("/unsubscribe", authenticate, PushController.unsubscribe);

export default router;
