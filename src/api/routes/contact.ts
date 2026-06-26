import { Router } from "express";
import rateLimit from "express-rate-limit";
import { ContactController } from "../controllers/contactController.js";

const router = Router();

// 5 submissions per IP per 15 minutes — fail-closed, no skip on trust proxy
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ?? "unknown",
  message: { error: "Too many messages. Please try again later.", code: "RATE_LIMIT_EXCEEDED" },
  skipSuccessfulRequests: false,
});

router.post("/", contactLimiter, ContactController.submitContactMessage);

export default router;
