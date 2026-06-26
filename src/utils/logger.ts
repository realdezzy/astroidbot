import { AsyncLocalStorage } from "node:async_hooks";
import { LogLevel } from "../types.js";

export const loggerStorage = new AsyncLocalStorage<Map<string, string>>();

function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value instanceof Error) {
      result[key] = {
        message: value.message,
        name: value.name,
        stack: value.stack?.split("\n").slice(0, 4).join("\n"),
      };
    } else {
      result[key] = value;
    }
  }
  return result;
}

export class Logger {
  private static level: LogLevel = LogLevel.INFO;

  static setLevel(level: LogLevel): void {
    Logger.level = level;
  }

  static fromString(level: string): LogLevel {
    const upper = level.toUpperCase();
    if (upper in LogLevel) {
      return LogLevel[upper as keyof typeof LogLevel];
    }
    return LogLevel.INFO;
  }

  private format(level: string, message: string, data?: Record<string, unknown>): string {
    const ts = new Date().toISOString();
    const store = loggerStorage.getStore();
    const correlationId = store?.get("correlationId");
    const isJson = process.env.LOG_FORMAT === "json";
    const sanitized = data ? sanitizeData(data) : undefined;

    if (isJson) {
      return JSON.stringify({
        timestamp: ts,
        level,
        message,
        correlationId: correlationId || undefined,
        ...(sanitized ? { data: sanitized } : {}),
      });
    }

    const correlationPrefix = correlationId ? ` [reqId:${correlationId}]` : "";
    const base = `[${ts}] [${level}]${correlationPrefix} ${message}`;
    if (sanitized) {
      return `${base} ${JSON.stringify(sanitized)}`;
    }
    return base;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (Logger.level <= LogLevel.DEBUG) {
      console.debug(this.format("DEBUG", message, data));
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (Logger.level <= LogLevel.INFO) {
      console.info(this.format("INFO", message, data));
    }
  }

  warn(message: string, data?: Record<string, unknown>): void {
    if (Logger.level <= LogLevel.WARN) {
      console.warn(this.format("WARN", message, data));
    }
  }

  error(message: string, data?: Record<string, unknown>): void {
    if (Logger.level <= LogLevel.ERROR) {
      console.error(this.format("ERROR", message, data));
    }
  }
}

export const logger = new Logger();