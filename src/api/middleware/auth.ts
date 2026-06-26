import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { ConfigManager } from "../../config.js";
import { DatabaseService } from "../../services/db.js";
import { UnauthorizedError, ForbiddenError } from "../errors.js";

export interface JwtPayload {
  userId: number;
  telegramId?: string;
}

declare global {
  namespace Express {
    interface Request {
      userId?: number;
      telegramId?: string;
    }
  }
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(new UnauthorizedError("Missing or invalid Authorization header"));
  }

  const token = authHeader.slice(7);

  try {
    const secret = ConfigManager.getInstance().config.JWT_SECRET;
    const payload = jwt.verify(token, secret) as JwtPayload;

    req.userId = payload.userId;
    req.telegramId = payload.telegramId;

    next();
  } catch {
    return next(new UnauthorizedError("Invalid or expired token"));
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }

  const token = authHeader.slice(7);

  try {
    const secret = ConfigManager.getInstance().config.JWT_SECRET;
    const payload = jwt.verify(token, secret) as JwtPayload;

    req.userId = payload.userId;
    req.telegramId = payload.telegramId;
  } catch {
    // Token invalid, continue without auth
  }

  next();
}

export async function requireAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.userId) {
    return next(new UnauthorizedError());
  }

  try {
    const db = DatabaseService.getInstance();
    const user = await db.findUserById(req.userId);

    if (!user?.isAdmin) {
      return next(new ForbiddenError("Admin access required"));
    }

    next();
  } catch {
    next(new ForbiddenError("Admin access required"));
  }
}
