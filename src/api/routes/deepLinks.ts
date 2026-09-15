import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { ConfigManager } from "../../config.js";
import { DeepLinkService, deepLinkTargetSchema } from "../../services/deepLinks/deepLinkService.js";
import { AppError } from "../errors.js";

const router = Router();

router.post("/", authenticate, validateBody(deepLinkTargetSchema), async (req, res, next) => {
  try {
    const username = ConfigManager.getInstance().config.TELEGRAM_BOT_USERNAME.replace(/^@/, "");
    if (!username) throw new AppError("Telegram bot username is not configured", 503, "TELEGRAM_UNAVAILABLE");
    const parameter = await new DeepLinkService().create({
      target: req.body,
      expectedUserId: req.userId!,
      source: "mini_app",
    });
    res.status(201).json({ parameter, url: `https://t.me/${username}?start=${parameter}` });
  } catch (error) { next(error); }
});

export default router;
