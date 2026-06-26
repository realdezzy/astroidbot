import { Router } from "express";
import { authenticate, optionalAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { AuthController } from "../controllers/authController.js";
import {
  telegramLoginSchema,
  emailRegisterSchema,
  emailLoginSchema,
  passwordResetRequestSchema,
  passwordResetExecuteSchema,
  changePasswordSchema,
  linkTelegramSchema,
  linkEmailSchema,
  refreshTokenSchema,
} from "../schemas.js";

const router = Router();

// Email Register
router.post("/email/register", validateBody(emailRegisterSchema), AuthController.registerEmail);

// Email Login
router.post("/email/login", validateBody(emailLoginSchema), AuthController.loginEmail);

// Email Verify
router.get("/email/verify/:token", AuthController.verifyEmail);

// Password Reset Request
router.post("/email/reset-password", validateBody(passwordResetRequestSchema), AuthController.requestPasswordReset);

// Password Reset Execute
router.post("/email/reset-password/:token", validateBody(passwordResetExecuteSchema), AuthController.executePasswordReset);

// Telegram Login / Link
router.post("/telegram", optionalAuth, validateBody(telegramLoginSchema), AuthController.loginOrLinkTelegram);

// Link Telegram (authenticated)
router.post("/telegram/link", authenticate, validateBody(linkTelegramSchema), AuthController.linkTelegram);

// Link Email (authenticated)
router.post("/email/link", authenticate, validateBody(linkEmailSchema), AuthController.linkEmail);

// Change Password (authenticated)
router.put("/password", authenticate, validateBody(changePasswordSchema), AuthController.changePassword);

// Linked Accounts
router.get("/linked-accounts", authenticate, AuthController.getLinkedAccounts);

// Unlink Telegram
router.delete("/telegram", authenticate, AuthController.unlinkTelegram);

// Refresh Token
router.post("/refresh", validateBody(refreshTokenSchema), AuthController.refreshToken);

// Logout
router.post("/logout", authenticate, validateBody(refreshTokenSchema), AuthController.logout);

export default router;
