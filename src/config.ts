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
  // Read off process.env before, which is why a typo in either was silent.
  CLICKHOUSE_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default("false"),
  CLICKHOUSE_URL: z.string().url().default("http://localhost:8123"),
  INDEXER_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().optional(),
  INDEXER_PORT: z.coerce.number().int().positive().default(8007),
  INDEXER_LOCK_TTL_MS: z.coerce.number().int().positive().default(300_000),
  // A floor in blocks. Chains that state a block time raise it to whatever
  // covers INDEXER_CONFIRMATION_SECONDS — see settingsForChain.
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).default(12),
  // The reorg depth that actually matters, in wall-clock seconds. 60s is
  // comfortably past sequencer-level reorgs on every L2 here and does not
  // reduce Ethereum, where 12 blocks is already 144s.
  INDEXER_CONFIRMATION_SECONDS: z.coerce.number().int().min(0).default(60),
  INDEXER_BLOCK_CHUNK_SIZE: z.coerce.number().int().positive().default(2_000),
  INDEXER_MAX_BLOCKS_PER_RUN: z.coerce.number().int().positive().default(20_000),
  INDEXER_INITIAL_LOOKBACK_BLOCKS: z.coerce.number().int().positive().default(50_000),
  // Recent history a never-indexed chain should reach on its first pass. The
  // downward backfill walk fills in the rest, so this only has to bootstrap.
  INDEXER_INITIAL_LOOKBACK_HOURS: z.coerce.number().int().positive().default(6),
  INDEXER_MAX_TX_PER_RUN: z.coerce.number().int().positive().default(300),
  INDEXER_MAX_POOLS_PER_CHAIN: z.coerce.number().int().positive().default(300),
  INDEXER_MAX_ADDRESSES_PER_FILTER: z.coerce.number().int().positive().default(100),
  INDEXER_MAX_SPLIT_DEPTH: z.coerce.number().int().min(0).default(12),
  INDEXER_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(1_000),
  INDEXER_MIN_POOL_LIQUIDITY_USD: z.coerce.number().min(0).default(10),
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

/** The subset of the environment that carries a secret worth checking. */
export interface PlaceholderCheckInput {
  AES_KEY: string;
  JWT_SECRET: string;
  AI_PROVIDER: "openai" | "google" | "deepseek";
  OPENAI_API_KEY?: string;
  GOOGLE_AI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ADMIN_IDS?: string;
}

/** Values copied out of `.env.example` and never replaced. */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^\.{2,}$/, //                     "..."
  /^sk-\.{2,}$/, //                  "sk-..."
  /^vx-\.{2,}$/,
  /^pim_\.{2,}$/,
  /change-me/i,
  /^your-/i,
  /^generate-a-random-string/i,
  /^1234567890:ABCdefGHIjklMNOpqrsTUVwxyz$/,
];

function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

/**
 * Why the AES key gets its own check rather than a pattern match.
 *
 * A 32-byte key drawn from a CSPRNG has each byte uniform over 0-255, so the
 * chance that all 32 land in printable ASCII is (95/256)^32 — about one in
 * 10^14. A value that decodes to nothing but printable characters is therefore
 * a string somebody typed, whatever it says. That is the check that catches a
 * key `z.string().min(1)` was happy with.
 */
function aesKeyProblem(value: string): string | null {
  const trimmed = value.trim();
  const decoded = Buffer.from(trimmed, "base64");

  // Buffer's base64 decoder ignores characters it doesn't recognise, so a
  // round trip is what actually establishes the input was base64 rather than
  // prose that happens to contain some base64 alphabet.
  if (decoded.toString("base64").replace(/=+$/, "") !== trimmed.replace(/=+$/, "")) {
    return "is not valid base64";
  }
  if (decoded.length !== 32) {
    return `decodes to ${decoded.length} bytes, but AES-256 needs exactly 32`;
  }
  if (decoded.every((byte) => byte >= 0x20 && byte <= 0x7e)) {
    return "decodes to nothing but printable ASCII, so it is a typed string rather than a random key";
  }
  return null;
}

/**
 * Refuses to boot on a secret that was never filled in.
 *
 * Every value here already had a validator, and every one of them passed:
 * `AES_KEY` was `z.string().min(1)` and held a 40-character sentence;
 * `JWT_SECRET` was `z.string().min(32)` and still read `change-me-in-…`. The
 * checks measured length where the property that matters is entropy.
 *
 * This runs at startup rather than at first use on purpose. A placeholder
 * OpenAI key surfaces as a 401 on somebody's request an hour later, and a
 * placeholder `AES_KEY` does not surface at all — it encrypts wallet keys
 * perfectly happily under a value anyone can read in the repository.
 *
 * Every offender is reported together. Reporting the first one turns a
 * container under `set -e` into a crash loop that discloses its causes one
 * restart at a time.
 */
export function assertNoPlaceholders(env: PlaceholderCheckInput): void {
  const problems: string[] = [];

  const aes = aesKeyProblem(env.AES_KEY);
  if (aes) {
    problems.push(
      `AES_KEY ${aes}. This key encrypts every wallet private key. ` +
        `Generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))" ` +
        `(or: openssl rand -base64 32).`
    );
  }

  if (looksLikePlaceholder(env.JWT_SECRET)) {
    problems.push(
      `JWT_SECRET is the placeholder from .env.example, so every session token is forgeable. ` +
        `Generate one with: node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))".`
    );
  }

  // Only the selected provider's credential has to be real. A stale
  // placeholder in a slot nothing reads is untidy, not a reason to refuse.
  const providerKey = {
    openai: ["OPENAI_API_KEY", env.OPENAI_API_KEY],
    google: ["GOOGLE_AI_API_KEY", env.GOOGLE_AI_API_KEY],
    deepseek: ["DEEPSEEK_API_KEY", env.DEEPSEEK_API_KEY],
  }[env.AI_PROVIDER] as [string, string | undefined];

  if (providerKey[1] && looksLikePlaceholder(providerKey[1])) {
    problems.push(
      `${providerKey[0]} is a placeholder, and AI_PROVIDER is "${env.AI_PROVIDER}", ` +
        `so every AI request would fail with a 401 at request time.`
    );
  }

  // Absent is a decision — a deployment with no Telegram bot is valid, and
  // must not be made to invent a credential in order to boot. Only a value
  // that is set *and* fake is a problem.
  if (env.TELEGRAM_BOT_TOKEN && looksLikePlaceholder(env.TELEGRAM_BOT_TOKEN)) {
    problems.push("TELEGRAM_BOT_TOKEN is the example token. Unset it, or set a real one.");
  }
  if (env.TELEGRAM_ADMIN_IDS?.trim() === "123456789") {
    problems.push(
      "TELEGRAM_ADMIN_IDS is the example id, so the admin gate names a user that does not exist."
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start: ${problems.length} placeholder secret(s) found in the environment.\n` +
        problems.map((p) => `  - ${p}`).join("\n")
    );
  }
}

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

    // Armed everywhere but the test suite, whose fixtures deliberately use
    // fake secrets across 44 files. `assertNoPlaceholders` is covered directly
    // in tests/config/placeholders.test.ts, so skipping it here costs no
    // coverage — it only stops the fixtures from having to carry real entropy.
    if (process.env.NODE_ENV !== "test") {
      assertNoPlaceholders(this.config);
    }

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

    // Throws on a malformed URL. Better at startup than as a chain that looks
    // enabled and silently talks to nothing.
    const overrides = Object.keys(this.rpcOverrides);
    if (overrides.length > 0) {
      logger.info("Per-chain RPC overrides in effect", { vars: overrides });
    }

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

  /**
   * Per-chain RPC overrides, as `RPC_URL_<CHAIN>_<NETWORK>` → url.
   *
   * These cannot be zod fields — the names depend on which chains a deployment
   * enables — but that is not a reason to leave them unvalidated and
   * undiscoverable. They were read straight off `process.env` at six call
   * sites, so a typo'd variable name silently changed nothing, and the only
   * symptom was a chain quietly running against its public default endpoint.
   *
   * Validated here and logged at startup, so what each chain is actually
   * talking to is a fact in the first few lines of the log.
   */
  get rpcOverrides(): Record<string, string> {
    const out: Record<string, string> = {};

    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("RPC_URL_") || !value) continue;

      try {
        new URL(value);
        out[key] = value;
      } catch {
        throw new Error(
          `${key} is not a valid URL. Expected something like ` +
            `https://base-mainnet.example.com/v2/<key>, got "${value}".`
        );
      }
    }

    return out;
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
