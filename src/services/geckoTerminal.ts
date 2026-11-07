import axios, { type AxiosInstance } from "axios";
import { ConfigManager } from "../config.js";
import { RedisService } from "./redis.js";
import { logger } from "../utils/logger.js";
import type { ChainId } from "../types/chain.js";

/**
 * HTTP client for GeckoTerminal / CoinGecko's onchain API.
 *
 * This is the "buy it" half of the hybrid market-data split: pool discovery
 * and liquidity stay on-chain (our index sees a new pool before an aggregator
 * lists it), while price, volume and candles come from here rather than from
 * several thousand lines of swap-ingestion machinery that recomputes what this
 * API already computes correctly.
 *
 * Three things about it are load-bearing:
 *
 * **The rate limit is the binding constraint, not latency.** Keyless is 30
 * calls a minute — a single discovery page can spend that — so every read
 * batches as hard as the endpoint allows (30 token addresses per call) and
 * lands in a *Redis* cache rather than a per-process one. Two processes read
 * this API (the API server and the indexer); a per-process cache would double
 * the call rate against a limit counted per minute.
 *
 * **A 429 means stop asking, not ask again.** A 429 sets a process-wide
 * cooldown and every call during it answers from cache or with nothing. The
 * failure mode this avoids is the one that already happened to the indexer's
 * range splitter: retrying into a limit is what keeps you inside it.
 *
 * **The numbers are not all trustworthy.** `total_reserve_in_usd` returned a
 * ~600-digit value for USDC on Base during the evaluation — not a large pool,
 * a broken field. Everything monetary goes through `usdOrNull`, which returns
 * null for non-finite or absurd values, because a missing number sorts out of
 * the way and a nonsense one sorts to the top.
 *
 * Note that `bootstrap()` patches `axios.defaults` process-wide for the
 * browser TLS/User-Agent fingerprint, so this client inherits it — the
 * instance is created lazily for exactly that reason.
 */

/** Free tier. 30 calls/minute, no key. */
const PUBLIC_BASE_URL = "https://api.geckoterminal.com/api/v2";

/** Paid tier, same routes under a prefix. 500 calls/minute with a key. */
const PRO_BASE_URL = "https://pro-api.coingecko.com/api/v3/onchain";

/** The endpoint's own cap on a `tokens/multi` address list. */
export const MAX_TOKENS_PER_CALL = 30;

/** The endpoint's own cap on an OHLCV page. */
export const MAX_CANDLES_PER_CALL = 1000;

/** How long a 429 silences this client. Their window is a minute. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/**
 * GeckoTerminal's network slug for each ChainId we can map.
 *
 * Their API keys on its own network names, so this table is the boundary
 * between their identifiers and ours — and a chain missing from it is
 * unsupported rather than guessed at. Asking an API that has no data for a
 * chain about that chain returns a cheerful empty list, which reads as "no
 * tokens" rather than "wrong question", and that mistake stays invisible until
 * someone asks why a chain looks dead.
 *
 * Arc is the standing example, and it is absent on purpose. GeckoTerminal does
 * publish an `arc` network — the slug would resolve — but it publishes no
 * pools on it, so mapping it would buy exactly the empty list described above.
 * Our own index covers Arc, and leaving it unmapped is what routes those reads
 * there. Add it when their network returns pools.
 *
 * `robinhood` and `stacks` were the two expected to block this and neither
 * does.
 */
/**
 * EVM addresses are case-insensitive; Solana mints and Stacks principals are
 * not. Lowercasing one of those produces a valid-looking address for a
 * different asset (or for nothing at all), which the API answers with an empty
 * result rather than an error — so the page simply showed no metrics.
 */
function normalizeAddress(address: string): string {
  return address.startsWith("0x") ? address.toLowerCase() : address;
}

const NETWORK_SLUGS: Record<string, string> = {
  "ethereum:mainnet": "eth",
  "base:mainnet": "base",
  "celo:mainnet": "celo",
  "robinhood:mainnet": "robinhood",
  "solana:mainnet": "solana",
  "stacks:mainnet": "stacks",
};

/** One OHLCV row, already in the shape `CandleData` wants. */
export interface GeckoOhlcv {
  timestampSeconds: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

/** What `tokens/multi` knows about one token. Every metric is nullable. */
export interface GeckoTokenMetrics {
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  imageUrl: string | null;
  priceUsd: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
}

/**
 * One `tokens/multi` response: the tokens asked for, plus whatever pools the
 * API attached. The pools are keyed back to their base token by the caller.
 */
export interface GeckoTokenBatch {
  tokens: GeckoTokenMetrics[];
  pools: GeckoPool[];
}

/** A pool, as the token-pools and new-pools endpoints report it. */
export interface GeckoPool {
  address: string;
  /** The API's own network slug, kept so a cross-chain search can be mapped back. */
  network: string | null;
  name: string | null;
  dexId: string | null;
  baseTokenAddress: string | null;
  reserveUsd: number | null;
  volume24h: number | null;
  priceUsd: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange6h: number | null;
  priceChange24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  createdAt: Date | null;
}

/** One trade from a pool's trade feed. */
export interface GeckoTrade {
  txHash: string;
  traderAddress: string | null;
  kind: "buy" | "sell";
  volumeUsd: number | null;
  priceUsd: number | null;
  blockNumber: number | null;
  timestamp: Date;
}

/** OHLCV resolutions the API serves, as `timeframe` plus an `aggregate`. */
export interface GeckoTimeframe {
  timeframe: "minute" | "hour" | "day";
  aggregate: number;
}

/**
 * Our timeframe strings mapped onto the API's timeframe/aggregate pairs.
 *
 * The API's finest resolution is a minute, which is finer than the five-minute
 * floor the internal index can serve — so a 1m chart becomes answerable when
 * this source is active, and unanswerable again when it isn't. That asymmetry
 * lives here rather than in `CandleService`, which only knows "the source
 * either serves this timeframe or it doesn't".
 */
const TIMEFRAMES: Record<string, GeckoTimeframe> = {
  "1m": { timeframe: "minute", aggregate: 1 },
  "5m": { timeframe: "minute", aggregate: 5 },
  "15m": { timeframe: "minute", aggregate: 15 },
  "1h": { timeframe: "hour", aggregate: 1 },
  "4h": { timeframe: "hour", aggregate: 4 },
  "1d": { timeframe: "day", aggregate: 1 },
};

export function geckoTimeframe(timeframe: string): GeckoTimeframe | null {
  return TIMEFRAMES[timeframe] ?? null;
}

/** Whether this API can say anything about a chain at all. */
export function geckoNetworkFor(chainId: ChainId | string): string | null {
  return NETWORK_SLUGS[chainId] ?? null;
}

/** ChainIds this client can address, for callers that need the reverse map. */
export function geckoChainIdFor(network: string): ChainId | null {
  for (const [chainId, slug] of Object.entries(NETWORK_SLUGS)) {
    if (slug === network) return chainId;
  }
  return null;
}

/** The JSON:API envelope every endpoint here returns. */
interface JsonApiResource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id?: string; type?: string } | null }>;
}

interface JsonApiResponse {
  data?: JsonApiResource | JsonApiResource[];
  included?: JsonApiResource[];
  meta?: Record<string, unknown>;
}

export class GeckoTerminalService {
  private static instance: GeckoTerminalService;

  private client: AxiosInstance | null = null;

  /** Wall-clock time before which no request is made. Set by a 429. */
  private cooldownUntil = 0;

  /**
   * Request timestamps inside the current minute, used to stay under the
   * provider's limit instead of discovering it via a 429. A 429 silences the
   * whole client for a minute, so one avoidable request costs far more than
   * skipping it.
   */
  private callTimestamps: number[] = [];

  static getInstance(): GeckoTerminalService {
    if (!GeckoTerminalService.instance) {
      GeckoTerminalService.instance = new GeckoTerminalService();
    }
    return GeckoTerminalService.instance;
  }

  /** Test seam: the cooldown and the client are process state. */
  static reset(): void {
    GeckoTerminalService.instance = new GeckoTerminalService();
  }

  private get apiKey(): string | undefined {
    const key = ConfigManager.getInstance().config.GECKOTERMINAL_API_KEY;
    return key && key.length > 0 ? key : undefined;
  }

  /**
   * Built on first use, never at construction.
   *
   * `bootstrap()` rewrites `axios.defaults` to mimic a browser's TLS and
   * User-Agent fingerprint, and `axios.create` snapshots the defaults it is
   * called with — so an instance built at module load would be the one client
   * in the process that Cloudflare rejects.
   */
  private get http(): AxiosInstance {
    if (!this.client) {
      const key = this.apiKey;
      this.client = axios.create({
        baseURL: key ? PRO_BASE_URL : PUBLIC_BASE_URL,
        timeout: 10_000,
        headers: key ? { "x-cg-pro-api-key": key } : {},
      });
    }
    return this.client;
  }

  private get cacheTtl(): number {
    return ConfigManager.getInstance().config.GECKOTERMINAL_CACHE_TTL_SECONDS;
  }

  supportsChain(chainId: ChainId): boolean {
    return geckoNetworkFor(chainId) !== null;
  }

  /**
   * Metrics for any number of tokens, in calls of thirty.
   *
   * Addresses the API doesn't know are simply absent from the result rather
   * than present with zeros — the caller distinguishes "no data" from "no
   * activity", and this is where that distinction starts.
   *
   * `include=top_pools` is what makes the 5M/1H/6H/24H columns answerable at
   * all: the percentage changes and transaction counts live on a *pool*, not
   * on a token, and asking per token would be one call each — thirty times the
   * request budget for the same page. If the parameter is ever dropped the
   * `included` array is simply absent and those columns go null, which is the
   * honest reading of "we don't have it" rather than a zero.
   */
  async tokenMetrics(chainId: ChainId, addresses: string[]): Promise<GeckoTokenBatch> {
    const network = geckoNetworkFor(chainId);
    const empty: GeckoTokenBatch = { tokens: [], pools: [] };
    if (!network || addresses.length === 0) return empty;

    const unique = [...new Set(addresses.map(normalizeAddress))];
    const tokens: GeckoTokenMetrics[] = [];
    const pools: GeckoPool[] = [];

    for (let i = 0; i < unique.length; i += MAX_TOKENS_PER_CALL) {
      const batch = unique.slice(i, i + MAX_TOKENS_PER_CALL);
      const body = await this.get(
        `/networks/${network}/tokens/multi/${batch.join(",")}?include=top_pools`
      );
      // Null means rate-limited or failed; further batches in this pass will
      // fail the same way, so stop rather than burn the whole budget on them.
      if (!body) break;
      for (const row of asArray(body?.data)) {
        const token = this.toTokenMetrics(row);
        if (token) tokens.push(token);
      }
      for (const row of body?.included ?? []) {
        if (row.type === "pool") pools.push(this.toPool(row));
      }
    }

    return { tokens, pools };
  }

  /** The pools a token trades in, deepest first as the API returns them. */
  async topPools(chainId: ChainId, address: string): Promise<GeckoPool[]> {
    const network = geckoNetworkFor(chainId);
    if (!network) return [];

    const body = await this.get(`/networks/${network}/tokens/${normalizeAddress(address)}/pools`);
    return asArray(body?.data).map((row) => this.toPool(row));
  }

  /** The newest pools on a chain. A cross-check against our own discovery. */
  async newPools(chainId: ChainId, page = 1): Promise<GeckoPool[]> {
    const network = geckoNetworkFor(chainId);
    if (!network) return [];

    const body = await this.get(`/networks/${network}/new_pools?page=${page}`);
    return asArray(body?.data).map((row) => this.toPool(row));
  }

  /**
   * OHLCV for one pool.
   *
   * `token=base` asks for the candles denominated in the *base* token of the
   * pool rather than whichever side the API would pick, so a chart of WETH/USDC
   * and a chart of USDC/WETH are the same chart. Without it the same pool can
   * return prices that are each other's reciprocal depending on token ordering,
   * which renders as a plausible-looking and entirely wrong chart.
   */
  async ohlcv(
    chainId: ChainId,
    poolAddress: string,
    timeframe: string,
    limit: number,
    beforeTimestampSeconds?: number
  ): Promise<GeckoOhlcv[]> {
    const network = geckoNetworkFor(chainId);
    const resolution = geckoTimeframe(timeframe);
    if (!network || !resolution) return [];

    const query = new URLSearchParams({
      aggregate: String(resolution.aggregate),
      limit: String(Math.min(Math.max(1, limit), MAX_CANDLES_PER_CALL)),
      currency: "usd",
      token: "base",
    });
    if (beforeTimestampSeconds !== undefined) {
      query.set("before_timestamp", String(Math.floor(beforeTimestampSeconds)));
    }

    const body = await this.get(
      `/networks/${network}/pools/${normalizeAddress(poolAddress)}/ohlcv/${resolution.timeframe}?${query.toString()}`
    );

    const attributes = (asOne(body?.data)?.attributes ?? {}) as { ohlcv_list?: unknown };
    const list = Array.isArray(attributes.ohlcv_list) ? attributes.ohlcv_list : [];

    return list
      .map((row) => toOhlcv(row))
      .filter((row): row is GeckoOhlcv => row !== null)
      // The API pages newest-first; every consumer here wants chronological.
      .sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  }

  /** Recent trades in a pool, newest first. */
  async trades(
    chainId: ChainId,
    poolAddress: string,
    minVolumeUsd?: number
  ): Promise<GeckoTrade[]> {
    const network = geckoNetworkFor(chainId);
    if (!network) return [];

    const query =
      minVolumeUsd && minVolumeUsd > 0
        ? `?trade_volume_in_usd_greater_than=${minVolumeUsd}`
        : "";

    const body = await this.get(
      `/networks/${network}/pools/${normalizeAddress(poolAddress)}/trades${query}`
    );

    return asArray(body?.data)
      .map((row) => this.toTrade(row))
      .filter((row): row is GeckoTrade => row !== null);
  }

  /**
   * Free-text pool search.
   *
   * Scoped to one network when given. Pools rather than tokens because that is
   * the search this API exposes; the caller folds them back to base tokens.
   */
  async searchPools(query: string, chainId?: ChainId): Promise<GeckoPool[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const network = chainId ? geckoNetworkFor(chainId) : undefined;
    if (chainId && !network) return [];

    const params = new URLSearchParams({ query: trimmed });
    if (network) params.set("network", network);

    const body = await this.get(`/search/pools?${params.toString()}`);
    return asArray(body?.data).map((row) => this.toPool(row));
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────

  /**
   * One cached, rate-limit-aware GET.
   *
   * Errors are swallowed into `null` rather than thrown. Every caller here is
   * rendering a page or refreshing a metric, and "the third party is having a
   * bad minute" must degrade to a missing number, not to a failed request —
   * the same rule `FallbackMarketDataProvider` applies one layer up. A 429 is
   * the one error that also changes future behaviour.
   */
  private async get(path: string): Promise<JsonApiResponse | null> {
    const cacheKey = `gt:${path}`;
    const redis = RedisService.getInstance();

    const hit = await redis.get(cacheKey).catch(() => null);
    if (hit) {
      try {
        return JSON.parse(hit) as JsonApiResponse;
      } catch {
        // A corrupt cache entry is not worth a failed request.
      }
    }

    if (Date.now() < this.cooldownUntil) {
      logger.debug("[geckoterminal] skipped while rate-limited", { path });
      return null;
    }

    // Stay below the published limit rather than letting a 429 discover it for
    // us. The keyless tier is 30/min; a paid key is 500/min.
    const perMinute = this.apiKey ? 500 : 30;
    const now = Date.now();
    this.callTimestamps = this.callTimestamps.filter((t) => now - t < 60_000);
    if (this.callTimestamps.length >= perMinute) {
      logger.debug("[geckoterminal] local request budget exhausted", { path, perMinute });
      return null;
    }
    this.callTimestamps.push(now);

    try {
      const response = await this.http.get<JsonApiResponse>(path);
      const body = response.data;
      await redis.set(cacheKey, JSON.stringify(body), this.cacheTtl).catch(() => {});
      return body;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;

      if (status === 429) {
        // Retry-After when they send one, their window otherwise. Retrying
        // into a rate limit is what keeps you inside it.
        const retryAfter = axios.isAxiosError(error)
          ? Number(error.response?.headers?.["retry-after"])
          : NaN;
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : RATE_LIMIT_COOLDOWN_MS;
        this.cooldownUntil = Date.now() + waitMs;
        logger.warn("[geckoterminal] rate limited; pausing calls", {
          path,
          waitMs,
          keyed: Boolean(this.apiKey),
        });
        return null;
      }

      logger.debug("[geckoterminal] request failed", {
        path,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // ─── Mapping ───────────────────────────────────────────────────────────────

  private toTokenMetrics(row: JsonApiResource): GeckoTokenMetrics | null {
    const attributes = row.attributes ?? {};
    const address = str(attributes.address) ?? idAddress(row.id);
    if (!address) return null;

    const volume = attributes.volume_usd as Record<string, unknown> | undefined;

    return {
      address: normalizeAddress(address),
      symbol: str(attributes.symbol) ?? undefined,
      name: str(attributes.name) ?? undefined,
      decimals: int(attributes.decimals) ?? undefined,
      imageUrl: imageOrNull(str(attributes.image_url)),
      priceUsd: usdOrNull(attributes.price_usd),
      volume24h: usdOrNull(volume?.h24),
      liquidityUsd: usdOrNull(attributes.total_reserve_in_usd),
      // FDV stands in when a circulating market cap is unknown, matching how
      // the DexScreener provider resolves the same column.
      marketCapUsd: usdOrNull(attributes.market_cap_usd) ?? usdOrNull(attributes.fdv_usd),
    };
  }

  private toPool(row: JsonApiResource): GeckoPool {
    const attributes = row.attributes ?? {};
    const change = attributes.price_change_percentage as Record<string, unknown> | undefined;
    const volume = attributes.volume_usd as Record<string, unknown> | undefined;
    const txns = attributes.transactions as Record<string, unknown> | undefined;
    const day = txns?.h24 as Record<string, unknown> | undefined;

    const baseTokenId = row.relationships?.base_token?.data?.id;
    const baseTokenAddress = idAddress(baseTokenId);
    const dexId = row.relationships?.dex?.data?.id;

    return {
      address: normalizeAddress(str(attributes.address) ?? idAddress(row.id) ?? ""),
      network: row.relationships?.network?.data?.id ?? idNetwork(row.id),
      name: str(attributes.name),
      dexId: dexId ?? null,
      baseTokenAddress: baseTokenAddress ? normalizeAddress(baseTokenAddress) : null,
      reserveUsd: usdOrNull(attributes.reserve_in_usd),
      volume24h: usdOrNull(volume?.h24),
      priceUsd: usdOrNull(attributes.base_token_price_usd),
      priceChange5m: num(change?.m5),
      priceChange1h: num(change?.h1),
      priceChange6h: num(change?.h6),
      priceChange24h: num(change?.h24),
      buys24h: int(day?.buys),
      sells24h: int(day?.sells),
      createdAt: date(attributes.pool_created_at),
    };
  }

  private toTrade(row: JsonApiResource): GeckoTrade | null {
    const attributes = row.attributes ?? {};
    const txHash = str(attributes.tx_hash);
    const timestamp = date(attributes.block_timestamp);
    if (!txHash || !timestamp) return null;

    return {
      txHash,
      traderAddress: str(attributes.tx_from_address),
      kind: str(attributes.kind) === "sell" ? "sell" : "buy",
      volumeUsd: usdOrNull(attributes.volume_in_usd),
      priceUsd: usdOrNull(attributes.price_to_in_usd),
      blockNumber: int(attributes.block_number),
      timestamp,
    };
  }
}

// ─── Parsing helpers ─────────────────────────────────────────────────────────

function asArray(data: JsonApiResponse["data"]): JsonApiResource[] {
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

function asOne(data: JsonApiResponse["data"]): JsonApiResource | null {
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

/**
 * The address half of a JSON:API id.
 *
 * Ids are `"<network>_<address>"` (`"base_0x4200…"`), and Solana mints contain
 * no underscore while network slugs do not either — so the first underscore is
 * the separator and everything after it is the address.
 */
function idAddress(id: string | undefined | null): string | null {
  if (!id) return null;
  const separator = id.indexOf("_");
  return separator === -1 ? id : id.slice(separator + 1);
}

/**
 * The network half of a JSON:API id.
 *
 * A cross-chain search returns pools from every network at once and the
 * attributes say nothing about which — the id prefix is the only thing that
 * does, so a result whose id has no prefix is unattributable and dropped
 * rather than assigned to the chain that happened to be asked about.
 */
function idNetwork(id: string | undefined | null): string | null {
  if (!id) return null;
  const separator = id.indexOf("_");
  return separator === -1 ? null : id.slice(0, separator);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: unknown): number | null {
  const parsed = num(value);
  return parsed === null ? null : Math.trunc(parsed);
}

/**
 * A monetary figure, or null.
 *
 * Negative, non-finite and absurd values all mean "this field is broken", and
 * the last one is not hypothetical: `total_reserve_in_usd` came back as a
 * ~600-digit number for USDC on Base. Rendering that is bad; sorting a
 * liquidity-ranked table by it is worse, because the broken row takes the top
 * spot on every page. Null sorts out of the way, which is what an unknown
 * value should do.
 */
function usdOrNull(value: unknown): number | null {
  const parsed = num(value);
  if (parsed === null || parsed < 0) return null;

  const ceiling = ConfigManager.getInstance().config.GECKOTERMINAL_MAX_LIQUIDITY_USD;
  if (parsed > ceiling) {
    logger.debug("[geckoterminal] discarded an implausible USD figure", { value: String(value) });
    return null;
  }

  return parsed;
}

function imageOrNull(value: string | null): string | null {
  // Their placeholder for "no logo", which is not a URL worth rendering.
  return value && value !== "missing.png" ? value : null;
}

function date(value: unknown): Date | null {
  if (typeof value === "number") return new Date(value * 1000);
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** One `[ts, o, h, l, c, v]` row. Any malformed entry is dropped, not zeroed. */
function toOhlcv(row: unknown): GeckoOhlcv | null {
  if (!Array.isArray(row) || row.length < 6) return null;

  const values = row.slice(0, 6).map((v) => num(v));
  if (values.some((v) => v === null)) return null;

  const [timestampSeconds, open, high, low, close, volumeUsd] = values as number[];
  return {
    timestampSeconds: timestampSeconds!,
    open: open!,
    high: high!,
    low: low!,
    close: close!,
    volumeUsd: volumeUsd!,
  };
}
