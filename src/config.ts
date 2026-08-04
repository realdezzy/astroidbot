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
  BASE_NETWORK: z.enum(["mainnet", "sepolia"]).default("sepolia"),
  BASE_RPC_URL: z.string().url().optional(),
  PIMLICO_API_KEY: z.string().optional(),
  // Comma-separated ChainIds this deployment transacts on, e.g.
  // "stacks:mainnet,base:mainnet,solana:mainnet". The default keeps existing
  // deployments byte-for-byte identical: Stacks only. A chain named here that
  // isn't in the descriptor catalogue (or lacks its required credentials) is a
  // startup failure, never a silent skip.
  ENABLED_CHAINS: z.string().default("stacks:mainnet"),
  // JSON array of EvmChainSpec for networks not in the built-in catalogue —
  // the supported path for an L2 whose router addresses we can't pin from
  // here. See descriptors/defineEvmChain.ts.
  CUSTOM_EVM_CHAINS: z.string().default(""),

  // ─── Market data ───────────────────────────────────────────────────────────
  // Where token prices, volume and transaction counts come from.
  //   internal    — our own swap index. Production.
  //   dexscreener — third-party API. Development only; it puts someone else's
  //                 rate limit in our request path.
  //   auto        — internal, falling back per chain while an index warms up.
  MARKET_DATA_PROVIDER: z.enum(["internal", "dexscreener", "auto"]).default("internal"),

  // Ingestion runs in the indexer process (src/indexer.ts) and nowhere else.
  // There is no flag for this: the API process has no ingestion code path to
  // enable, and a deployment that doesn't want market data doesn't run the
  // container. A flag would only have described which processes were disobeying
  // the rule.
  //
  // How often that process ingests. Unset means POLL_INTERVAL_SECONDS — the
  // cadence the numbers were designed around — but the two processes have
  // genuinely different cost profiles and a deployment may want the indexer
  // slower.
  INDEXER_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().optional(),
  // Health port for the indexer process. It serves nothing else — this exists
  // so the container has something to health-check.
  INDEXER_PORT: z.coerce.number().int().positive().default(8007),
  // TTL on the per-chain ingestion lock. Sized well above a normal run: the
  // lock is what stops two processes ingesting the same chain and
  // double-counting additively-accumulated volume, and expiring it early would
  // hand that guarantee away.
  INDEXER_LOCK_TTL_MS: z.coerce.number().int().positive().default(300_000),
  // Blocks to stay behind the head. The cursor must never enter a range that
  // can still be reorged out, or ingested volume becomes unattributable.
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).default(12),
  // Blocks per eth_getLogs call. Most providers cap the range; 2000 is a
  // widely-accepted ceiling.
  INDEXER_BLOCK_CHUNK_SIZE: z.coerce.number().int().positive().default(2_000),
  // Ceiling per tick, so a chain that has fallen behind catches up across
  // several cycles instead of monopolising one.
  INDEXER_MAX_BLOCKS_PER_RUN: z.coerce.number().int().positive().default(20_000),
  // How far back a never-indexed chain starts. Deliberately not a full
  // backfill: discovery pages want what is trading now.
  INDEXER_INITIAL_LOOKBACK_BLOCKS: z.coerce.number().int().positive().default(50_000),
  // Pools tracked per chain, most-recently-active first.
  INDEXER_MAX_POOLS_PER_CHAIN: z.coerce.number().int().positive().default(300),
  // Addresses per log filter; providers reject very large arrays.
  INDEXER_MAX_ADDRESSES_PER_FILTER: z.coerce.number().int().positive().default(100),
  // Times a failing log range may be halved before the indexer gives up on it.
  // Providers cap by *result count*, not block range, so no fixed chunk size is
  // safe and subdivision is the only reliable response.
  INDEXER_MAX_SPLIT_DEPTH: z.coerce.number().int().min(0).default(12),
  // Pause before the single retry a transient RPC failure gets. Transient
  // failures are not retried recursively — that turns one slow endpoint into a
  // request storm against an endpoint that is already struggling.
  INDEXER_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(1_000),
  // Below this, a pool's quoted price is whatever the last trader decided, so
  // activity is still counted but the price is not trusted.
  INDEXER_MIN_POOL_LIQUIDITY_USD: z.coerce.number().min(0).default(1_000),
  // Candles older than this are dropped — no window reads them.
  INDEXER_CANDLE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  // How much history the backfill walks back to cover, in hours. Defaults to
  // the widest window the UI renders: with less than this a freshly-indexed
  // chain shows a 24H column computed from six hours of data, which is not
  // visibly wrong and is wrong.
  INDEXER_BACKFILL_WINDOW_HOURS: z.coerce.number().int().min(0).default(24),
  // Ceiling on backfilled blocks per tick. Separate from
  // INDEXER_MAX_BLOCKS_PER_RUN so backfill can be given a smaller share:
  // history is worth having, but never at the cost of falling behind the head.
  INDEXER_MAX_BACKFILL_BLOCKS_PER_RUN: z.coerce.number().int().positive().default(10_000),
  // Social trading. Off by default and deliberately so: this surface lets a
  // public post move real funds, and it should be a considered decision to
  // enable rather than something that arrives with an upgrade.
  // Enum-transformed, not z.coerce.boolean(): Boolean("false") is true, so a
  // coerced kill switch would be *enabled* by the very value meant to disable
  // it. DRY_RUN above uses the same shape for the same reason.
  SOCIAL_TRADING_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default("false"),
  SOCIAL_BOT_HANDLES: z.string().default(""),
  X_BEARER_TOKEN: z.string().optional(),
  NEYNAR_API_KEY: z.string().optional(),
  // The bot's own Farcaster account id. Numeric and permanent, unlike a
  // username — mentions are polled against it.
  FARCASTER_BOT_FID: z.string().optional(),
  // Reading mentions needs only an API key; posting a reply needs a signer.
  NEYNAR_SIGNER_UUID: z.string().optional(),
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

  /**
   * Test-only: drop the cached config so the next load() re-reads process.env.
   * load() is deliberately idempotent in production — config must not change
   * under a running process — which leaves tests unable to exercise more than
   * one environment without this seam.
   */
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
