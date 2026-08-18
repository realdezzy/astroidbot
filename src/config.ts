import dotenv from "dotenv";
import { z } from "zod";
import { logger, Logger } from "./utils/logger.js";

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
  TELEGRAM_WEBHOOK_URL: z.preprocess((val) => (val === "" ? undefined : val), z.string().url().optional()),
  TELEGRAM_ADMIN_IDS: z.string().default(""),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(14).default(12),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().default(""),
  PORT: z.coerce.number().int().min(0).default(8006),
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
  BASE_NETWORK: z.enum(["mainnet", "sepolia"]).default("sepolia"),
  BASE_RPC_URL: z.string().url().optional(),
  PIMLICO_API_KEY: z.string().optional(),
  ENABLED_CHAINS: z
    .string()
    .default("stacks:mainnet,base:mainnet,robinhood:mainnet,solana:mainnet"),
  CUSTOM_EVM_CHAINS: z.string().default(""),
  JUPITER_API_KEY: z.string().optional(),
  MARKET_DATA_PROVIDER: z.enum(["internal", "dexscreener", "auto"]).default("internal"),
  INDEXER_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().optional(),
  INDEXER_PORT: z.coerce.number().int().positive().default(8007),
  INDEXER_LOCK_TTL_MS: z.coerce.number().int().positive().default(300_000),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).default(12),
  INDEXER_BLOCK_CHUNK_SIZE: z.coerce.number().int().positive().default(2_000),
  INDEXER_MAX_BLOCKS_PER_RUN: z.coerce.number().int().positive().default(20_000),
  INDEXER_INITIAL_LOOKBACK_BLOCKS: z.coerce.number().int().positive().default(50_000),
  INDEXER_MAX_TX_PER_RUN: z.coerce.number().int().positive().default(300),
  INDEXER_MAX_POOLS_PER_CHAIN: z.coerce.number().int().positive().default(300),
  INDEXER_MAX_ADDRESSES_PER_FILTER: z.coerce.number().int().positive().default(100),
  INDEXER_MAX_SPLIT_DEPTH: z.coerce.number().int().min(0).default(12),
  INDEXER_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(1_000),
  INDEXER_MIN_POOL_LIQUIDITY_USD: z.coerce.number().min(0).default(1_000),
  INDEXER_SWAP_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  INDEXER_CANDLE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  INDEXER_BACKFILL_WINDOW_HOURS: z.coerce.number().int().min(0).default(24),
  INDEXER_MAX_BACKFILL_BLOCKS_PER_RUN: z.coerce.number().int().positive().default(10_000),
  INDEXER_MAX_BACKFILL_SOURCES_PER_RUN: z.coerce.number().int().positive().default(10),
  INDEXER_BACKFILL_FULL_HISTORY: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default("false"),
  SOCIAL_TRADING_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default("false"),
  SOCIAL_BOT_HANDLES: z.string().default(""),
  SOCIAL_PER_TRADE_LIMIT_USD: z.coerce.number().positive().default(50),
  SOCIAL_DAILY_LIMIT_USD: z.coerce.number().positive().default(200),
  X_BEARER_TOKEN: z.string().optional(),
  NEYNAR_API_KEY: z.string().optional(),
  FARCASTER_BOT_FID: z.string().optional(),
  NEYNAR_SIGNER_UUID: z.string().optional(),
  VELAR_PERP_CONTRACT_ADDRESS: z.string().default("SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE"),
  VELAR_PERP_CONTRACT_NAME: z.string().default("velar-artha-perp"),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@astroidbot.io"),
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

  static reset(): void {
    ConfigManager.instance = undefined as unknown as ConfigManager;
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
