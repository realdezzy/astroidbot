import type { Request, Response, NextFunction } from "express";
import type { ZodSchema } from "zod";
import { ValidationError } from "../errors.js";

export function validateBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const details = result.error.flatten();
      return next(new ValidationError("Invalid request body", details));
    }

    req.body = result.data;
    next();
  };
}

export function validateQuery(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      const details = result.error.flatten();
      return next(new ValidationError("Invalid query parameters", details));
    }

    // Express v5: req.query is read-only — copy validated values into a new property
    (req as Request & { validatedQuery: Record<string, unknown> }).validatedQuery = result.data as Record<string, unknown>;
    next();
  };
}

export function validateParams(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      const details = result.error.flatten();
      return next(new ValidationError("Invalid route parameters", details));
    }

    req.params = result.data;
    next();
  };
}
