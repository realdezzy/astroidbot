import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { ConfigManager } from "../../config.js";
import { DatabaseService } from "../../services/db.js";
import { logger } from "../../utils/logger.js";
import { sendEmail, buildVerificationEmail, buildPasswordResetEmail } from "../../utils/email.js";
import { provisionDefaultWallet } from "../../services/wallet.js";
import {
  UnauthorizedError,
  ValidationError,
  ConflictError,
  InternalError,
  NotFoundError,
} from "../errors.js";

function generateTokens(userId: number, telegramId?: string): { accessToken: string; refreshToken: string } {
  const config = ConfigManager.getInstance().config;

  const payload: Record<string, unknown> = { userId };
  if (telegramId) payload.telegramId = telegramId;

  const accessToken = jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRY as jwt.SignOptions["expiresIn"],
  });

  const refreshToken = crypto.randomBytes(48).toString("hex");

  return { accessToken, refreshToken };
}

function verifyTelegramHash(
  data: Record<string, string | number>,
  hash: string
): boolean {
  const botToken = ConfigManager.getInstance().config.TELEGRAM_BOT_TOKEN;
  if (!botToken) return false;

  const checkString = Object.keys(data)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join("\n");

  const secret = crypto.createHash("sha256").update(botToken).digest();
  const computed = crypto
    .createHmac("sha256", secret)
    .update(checkString)
    .digest("hex");

  return computed === hash;
}

async function storeRefreshToken(userId: number, refreshToken: string): Promise<void> {
  const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
  const expiry = new Date(
    Date.now() + ConfigManager.getInstance().config.REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000
  );
  await DatabaseService.getInstance().createRefreshToken(userId, tokenHash, expiry);
}

function formatUser(user: {
  id: number;
  telegramId: bigint | null;
  username: string | null;
  email: string | null;
  emailVerified: boolean;
  referralCode: string;
  points: number;
}) {
  return {
    id: user.id,
    telegramId: user.telegramId ? String(user.telegramId) : null,
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerified,
    referralCode: user.referralCode,
    points: user.points,
  };
}

export class AuthController {
  static async registerEmail(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { email, password, username } = req.body as {
        email: string;
        password: string;
        username?: string;
      };

      const db = DatabaseService.getInstance();
      const existing = await db.findUserByEmail(email);
      if (existing) {
        return next(new ConflictError("Email already registered"));
      }

      const rounds = ConfigManager.getInstance().config.BCRYPT_ROUNDS;
      const passwordHash = await bcrypt.hash(password, rounds);

      const user = await db.createEmailUser({ email, passwordHash, username });

      if (ConfigManager.getInstance().config.DRY_RUN) {
        await db.markEmailVerified(user.id);
      } else {
        const token = await db.createEmailToken(user.id, "VERIFY", 3600_000);
        const origin = ConfigManager.getInstance().config.CORS_ORIGIN || "http://localhost:5173";
        const link = `${origin}/verify/${token.token}`;
        const { subject, html } = buildVerificationEmail(link);
        await sendEmail(email, subject, html);
      }

      const { accessToken, refreshToken } = generateTokens(user.id);
      await storeRefreshToken(user.id, refreshToken);

      provisionDefaultWallet(user.id).catch((err) =>
        logger.error("Failed to provision default wallet", { userId: user.id, error: err })
      );

      res.status(201).json({
        accessToken,
        refreshToken,
        user: formatUser(user),
      });
    } catch (error) {
      logger.error("Email registration failed", { error });
      next(new InternalError("Registration failed"));
    }
  }

  static async loginEmail(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { email, password } = req.body as { email: string; password: string };

      const db = DatabaseService.getInstance();
      const user = await db.findUserByEmail(email);

      if (!user || !user.passwordHash) {
        return next(new UnauthorizedError("Invalid email or password"));
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return next(new UnauthorizedError("Invalid email or password"));
      }

      if (!user.isActive) {
        return next(new UnauthorizedError("Account is disabled"));
      }

      const { accessToken, refreshToken } = generateTokens(
        user.id,
        user.telegramId ? String(user.telegramId) : undefined
      );
      await storeRefreshToken(user.id, refreshToken);

      res.json({ accessToken, refreshToken, user: formatUser(user) });
    } catch (error) {
      logger.error("Email login failed", { error });
      next(new InternalError("Login failed"));
    }
  }

  static async verifyEmail(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const token = String(req.params.token ?? "");
      const db = DatabaseService.getInstance();
      const record = await db.findEmailToken(token);

      if (!record || record.used || record.expiresAt < new Date()) {
        return next(new UnauthorizedError("Invalid or expired verification link"));
      }

      await db.markEmailVerified(record.userId);
      await db.consumeEmailToken(record.id);

      res.json({ ok: true });
    } catch (error) {
      logger.error("Email verification failed", { error });
      next(new InternalError("Verification failed"));
    }
  }

  static async requestPasswordReset(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { email } = req.body as { email: string };
      const db = DatabaseService.getInstance();
      const user = await db.findUserByEmail(email);

      if (!user) {
        return res.json({ ok: true, message: "If an account exists, a reset link has been sent." });
      }

      const token = await db.createEmailToken(user.id, "RESET", 3600_000);
      const origin = ConfigManager.getInstance().config.CORS_ORIGIN || "http://localhost:5173";
      const link = `${origin}/reset-password/${token.token}`;

      if (user.telegramId) {
        const { TelegramService } = await import("../../services/telegram.js");
        const tg = TelegramService.getInstance();
        await tg.sendAlert(user.id, `🔐 Password reset requested.\n\nClick here to reset: ${link}`);
      } else {
        const { subject, html } = buildPasswordResetEmail(link);
        await sendEmail(email, subject, html);
      }

      res.json({ ok: true, message: "If an account exists, a reset link has been sent." });
    } catch (error) {
      logger.error("Password reset request failed", { error });
      next(new InternalError("Reset request failed"));
    }
  }

  static async executePasswordReset(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const token = String(req.params.token ?? "");
      const { newPassword } = req.body as { newPassword: string };
      const db = DatabaseService.getInstance();

      const record = await db.findEmailToken(token);
      if (!record || record.used || record.expiresAt < new Date() || record.type !== "RESET") {
        return next(new UnauthorizedError("Invalid or expired reset link"));
      }

      const rounds = ConfigManager.getInstance().config.BCRYPT_ROUNDS;
      const passwordHash = await bcrypt.hash(newPassword, rounds);
      await db.updateUserPassword(record.userId, passwordHash);
      await db.consumeEmailToken(record.id);

      await db.prisma.refreshToken.updateMany({
        where: { userId: record.userId },
        data: { revoked: true },
      });

      res.json({ ok: true });
    } catch (error) {
      logger.error("Password reset execution failed", { error });
      next(new InternalError("Password reset failed"));
    }
  }

  static async loginOrLinkTelegram(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { id, first_name, username, auth_date, hash } = req.body;

      const ageSeconds = Math.floor(Date.now() / 1000) - auth_date;
      if (ageSeconds > 300) {
        return next(new UnauthorizedError("Telegram auth token expired"));
      }

      const data: Record<string, string | number> = {};
      if (id !== undefined) data.id = String(id);
      if (first_name) data.first_name = String(first_name);
      if (username) data.username = String(username);
      data.auth_date = auth_date;

      if (!verifyTelegramHash(data, hash)) {
        return next(new UnauthorizedError("Invalid Telegram hash"));
      }

      const db = DatabaseService.getInstance();
      let user = await db.findUserByTelegramId(id);

      if (req.userId && !user) {
        const existingByTelegram = await db.findUserByTelegramId(id);
        if (existingByTelegram && existingByTelegram.id !== req.userId) {
          return next(new ConflictError("This Telegram account is already linked to another user"));
        }
        user = await db.linkTelegramToUser(req.userId, id);
      } else if (!user) {
        user = await db.createUser({
          telegramId: id,
          username: username ?? first_name,
        });
        provisionDefaultWallet(user.id).catch((err) =>
          logger.error("Failed to provision default wallet", { userId: user?.id, error: err })
        );
      }

      if (!user.isActive) {
        return next(new UnauthorizedError("Account is disabled"));
      }

      const { accessToken, refreshToken } = generateTokens(user.id, String(id));
      await storeRefreshToken(user.id, refreshToken);

      res.json({ accessToken, refreshToken, user: formatUser(user) });
    } catch (error) {
      logger.error("Telegram login failed", { error });
      next(new InternalError("Login failed"));
    }
  }

  static async linkTelegram(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { id, first_name, username, auth_date, hash } = req.body;

      const ageSeconds = Math.floor(Date.now() / 1000) - auth_date;
      if (ageSeconds > 300) {
        return next(new UnauthorizedError("Telegram auth token expired"));
      }

      const data: Record<string, string | number> = {};
      if (id !== undefined) data.id = String(id);
      if (first_name) data.first_name = String(first_name);
      if (username) data.username = String(username);
      data.auth_date = auth_date;

      if (!verifyTelegramHash(data, hash)) {
        return next(new UnauthorizedError("Invalid Telegram hash"));
      }

      const db = DatabaseService.getInstance();
      const existingByTelegram = await db.findUserByTelegramId(id);
      if (existingByTelegram && existingByTelegram.id !== req.userId) {
        return next(new ConflictError("This Telegram account is already linked to another user"));
      }

      const user = await db.linkTelegramToUser(req.userId!, id);

      res.json({ user: formatUser(user) });
    } catch (error) {
      logger.error("Telegram linking failed", { error });
      next(new InternalError("Failed to link Telegram"));
    }
  }

  static async linkEmail(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { email, password } = req.body as { email: string; password: string };
      const db = DatabaseService.getInstance();

      const existingEmail = await db.findUserByEmail(email);
      if (existingEmail && existingEmail.id !== req.userId) {
        return next(new ConflictError("This email is already linked to another account"));
      }

      const user = await db.findUserById(req.userId!);
      if (!user) return next(new NotFoundError("User"));

      const rounds = ConfigManager.getInstance().config.BCRYPT_ROUNDS;
      const passwordHash = await bcrypt.hash(password, rounds);
      await db.linkEmailToUser(req.userId!, email, passwordHash);

      if (ConfigManager.getInstance().config.DRY_RUN) {
        await db.markEmailVerified(req.userId!);
      }

      res.json({ user: formatUser({ ...user, email, emailVerified: false }) });
    } catch (error) {
      logger.error("Email linking failed", { error });
      next(new InternalError("Failed to link email"));
    }
  }

  static async changePassword(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { currentPassword, newPassword } = req.body as {
        currentPassword: string;
        newPassword: string;
      };
      const db = DatabaseService.getInstance();
      const user = await db.findUserById(req.userId!);

      if (!user || !user.passwordHash) {
        return next(new UnauthorizedError("No password set — link an email first"));
      }

      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) {
        return next(new UnauthorizedError("Current password is incorrect"));
      }

      const rounds = ConfigManager.getInstance().config.BCRYPT_ROUNDS;
      const passwordHash = await bcrypt.hash(newPassword, rounds);
      await db.updateUserPassword(req.userId!, passwordHash);

      await db.prisma.refreshToken.updateMany({
        where: { userId: req.userId! },
        data: { revoked: true },
      });

      res.json({ ok: true });
    } catch (error) {
      logger.error("Password change failed", { error });
      next(new InternalError("Failed to change password"));
    }
  }

  static async getLinkedAccounts(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const db = DatabaseService.getInstance();
      const user = await db.findUserById(req.userId!);
      if (!user) return next(new NotFoundError("User"));

      res.json({
        email: user.email,
        emailVerified: user.emailVerified,
        telegramLinked: !!user.telegramId,
      });
    } catch (error) {
      logger.error("Linked accounts fetch failed", { error });
      next(new InternalError());
    }
  }

  static async unlinkTelegram(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const db = DatabaseService.getInstance();
      await db.unlinkTelegram(req.userId!);
      res.json({ ok: true });
    } catch (error) {
      logger.error("Telegram unlink failed", { error });
      next(new InternalError());
    }
  }

  static async refreshToken(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { refreshToken } = req.body;

      const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
      const db = DatabaseService.getInstance();
      const stored = await db.findRefreshToken(tokenHash);

      if (!stored) {
        return next(new UnauthorizedError("Invalid or expired refresh token"));
      }

      if (stored.revoked) {
        await db.prisma.refreshToken.updateMany({
          where: { userId: stored.userId },
          data: { revoked: true },
        });
        logger.warn("Refresh token reuse detected; all user refresh tokens revoked", { userId: stored.userId });
        return next(new UnauthorizedError("Invalid or expired refresh token"));
      }

      if (stored.expiresAt < new Date()) {
        return next(new UnauthorizedError("Invalid or expired refresh token"));
      }

      const user = await db.findUserById(stored.userId);
      if (!user || !user.isActive) {
        return next(new UnauthorizedError("Account not found or disabled"));
      }

      await db.revokeRefreshToken(stored.id);

      const tokens = generateTokens(user.id, user.telegramId ? String(user.telegramId) : undefined);
      const newTokenHash = crypto.createHash("sha256").update(tokens.refreshToken).digest("hex");
      const expiry = new Date(
        Date.now() + ConfigManager.getInstance().config.REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000
      );
      await db.createRefreshToken(user.id, newTokenHash, expiry);

      res.json({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    } catch (error) {
      logger.error("Token refresh failed", { error });
      next(new InternalError("Token refresh failed"));
    }
  }

  static async logout(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { refreshToken } = req.body;
      const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
      const db = DatabaseService.getInstance();
      const stored = await db.findRefreshToken(tokenHash);
      if (stored && stored.userId === req.userId) {
        await db.revokeRefreshToken(stored.id);
      }
      res.json({ ok: true });
    } catch (error) {
      logger.error("Logout failed", { error });
      next(new InternalError("Logout failed"));
    }
  }
}
