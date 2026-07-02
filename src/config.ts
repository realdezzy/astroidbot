import dotenv from "dotenv";
import { z } from "zod";
import { logger, Logger } from "./utils/logger.js";
import { LogLevel } from "./types.js";

dotenv.config();

const envSchema = z.object({
  ASTROIDBOT_DATABASE_URL: z.string().url(),
  AES_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_AI_API_KEY: z.string().optional(),
  AI_PROVIDER: z.enum(["openai", "google", "deepseek"]).default("openai"),
  AI_MODEL: z.string().default("gpt-4o"),
  DEEPSEEK_API_KEY: z.string().optional(),
  STACKS_NETWORK: z.enum(["mainnet", "testnet", "mocknet"]).default("testnet"),
  STACKS_API_URL: z.string().url().default("https://api.hiro.so"),
  HIRO_API_KEY: z.string().optional(),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  DRY_RUN: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default("true"),
  LOG_LEVEL: z.string().default("info"),
  ALLOWED_TOKENS: z.string().default(""),
  BLOCKED_TOKENS: z.string().default(""),
  DUST_THRESHOLD_USD: z.coerce.number().positive().default(0.5),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_BOT_USERNAME: z.string().default(""),
  TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
  TELEGRAM_ADMIN_IDS: z.string().default(""),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(14).default(12),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().default(""),
  PORT: z.coerce.number().int().positive().default(8006),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRY: z.string().default("15m"),
  REFRESH_TOKEN_EXPIRY_DAYS: z.coerce.number().int().positive().default(30),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  VELUMX_RELAYER_URL: z.string().url().optional(),
  VELUMX_API_KEY: z.string().optional(),
  STACKS_FALLBACK_API_URLS: z.string().default(""),
  KMS_PROVIDER: z.enum(["aws", "gcp", "local"]).default("local"),
  KMS_KEY_ID: z.string().optional(),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  VELAR_PERP_CONTRACT_ADDRESS: z.string().default("SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE"),
  VELAR_PERP_CONTRACT_NAME: z.string().default("velar-artha-perp"),
});

type EnvConfig = z.infer<typeof envSchema>;

export class ConfigManager {
  private static instance: ConfigManager;
  public readonly config: EnvConfig;
  private constructor() {
    const result = envSchema.safeParse(process.env);

    if (!result.success) {
      const errors = result.error.flatten().fieldErrors;
      logger.error("Environment validation failed", { errors });
      throw new Error(`Invalid environment configuration: ${JSON.stringify(errors)}`);
    }

    this.config = result.data;

    if (this.config.AI_PROVIDER === "openai" && !this.config.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required when AI_PROVIDER is openai");
    }
    if (this.config.AI_PROVIDER === "google" && !this.config.GOOGLE_AI_API_KEY) {
      throw new Error("GOOGLE_AI_API_KEY is required when AI_PROVIDER is google");
    }
    if (this.config.AI_PROVIDER === "deepseek" && !this.config.DEEPSEEK_API_KEY) {
      throw new Error("DEEPSEEK_API_KEY is required when AI_PROVIDER is deepseek");
    }

    Logger.setLevel(Logger.fromString(this.config.LOG_LEVEL));

    logger.info("Configuration loaded successfully", {
      aiProvider: this.config.AI_PROVIDER,
      network: this.config.STACKS_NETWORK,
      dryRun: this.config.DRY_RUN,
      pollInterval: this.config.POLL_INTERVAL_SECONDS,
      port: this.config.PORT,
    });
  }

  static load(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      throw new Error("ConfigManager not initialized. Call ConfigManager.load() first.");
    }
    return ConfigManager.instance;
  }

  get allowedTokens(): string[] {
    if (!this.config.ALLOWED_TOKENS) return [];
    return this.config.ALLOWED_TOKENS.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  get blockedTokens(): string[] {
    if (!this.config.BLOCKED_TOKENS) return [];
    return this.config.BLOCKED_TOKENS.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  get telegramAdminIds(): bigint[] {
    if (!this.config.TELEGRAM_ADMIN_IDS) return [];
    return this.config.TELEGRAM_ADMIN_IDS.split(",")
      .map((id) => {
        try {
          return BigInt(id.trim());
        } catch {
          return BigInt(0);
        }
      })
      .filter((id) => id > 0n);
  }
}
