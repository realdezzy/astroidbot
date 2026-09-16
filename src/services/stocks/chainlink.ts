import { createPublicClient, http, parseAbi, type Address } from "viem";
import { ChainAdapterRegistry } from "../chains/chainAdapterRegistry.js";
import { requireEvmConfig } from "../../types/chain.js";
import { rpcUrlOverride } from "../chains/evm/evmClient.js";
import { logger } from "../../utils/logger.js";

/**
 * Chainlink's standard aggregator interface. Tokenized-equity feeds present
 * exactly this, so a stock's reference price reads like any crypto feed.
 */
export const AGGREGATOR_V3_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export interface EquityPrice {
  priceUsd: number;
  asOf: Date;
  /**
   * True when `updatedAt` is older than the caller's bound.
   *
   * Returned rather than swallowed: equities legitimately hold their last close
   * overnight and over weekends, so "old" is the normal state off-hours. What
   * matters is that a caller which must not settle on a frozen price can tell.
   */
  stale: boolean;
}

/**
 * Reads tokenized-equity reference prices from Chainlink.
 *
 * The feed publishes `underlying equity price × multiplier` (a total-return
 * value maintained by the issuer), so it is the token's primary-market price
 * and not the AMM's — which on a thin after-hours book can be anything. That
 * makes it the right number to *display* for a stock and, later, the right
 * reference for triggers, once the staleness flag is honoured.
 *
 * Deliberately returns null, never 0, when an answer is unusable. Chainlink's
 * own guidance calls out that extended/overnight sessions can publish a
 * reported price of zero with a fresh timestamp; treating that as a real price
 * would value a position at nothing.
 */
export class EquityPriceOracle {
  private static instance: EquityPriceOracle;

  private readonly decimalsCache = new Map<string, number>();
  private readonly priceCache = new Map<string, { value: EquityPrice; at: number }>();

  constructor(
    /** How long a read is reused. Short: a stock price is what the UI shows. */
    private readonly ttlMs = 30_000,
    /** Age past which a price is flagged stale. A day covers a weekend hold. */
    private readonly maxStalenessSeconds = 24 * 60 * 60
  ) {}

  static getInstance(): EquityPriceOracle {
    return (this.instance ??= new EquityPriceOracle());
  }

  /** Test seam. */
  static reset(): void {
    this.instance = undefined as unknown as EquityPriceOracle;
  }

  private clientFor(chainId: string) {
    const registry = ChainAdapterRegistry.getInstance();
    if (!registry.has(chainId)) return null;
    const descriptor = registry.get(chainId).descriptor;
    if (descriptor.family !== "evm" || !descriptor.evm) return null;
    const evm = requireEvmConfig(descriptor);
    const url = rpcUrlOverride(chainId, evm.defaultRpcUrl);
    return createPublicClient({ transport: http(url, { timeout: 20_000, retryCount: 2 }) });
  }

  private async decimalsOf(client: ReturnType<EquityPriceOracle["clientFor"]>, feed: string): Promise<number | null> {
    if (!client) return null;
    const key = feed.toLowerCase();
    const cached = this.decimalsCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const raw = await client.readContract({
        address: key as Address,
        abi: AGGREGATOR_V3_ABI,
        functionName: "decimals",
      });
      const decimals = Number(raw);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
      this.decimalsCache.set(key, decimals);
      return decimals;
    } catch {
      return null;
    }
  }

  async price(chainId: string, feed: string, now = Date.now()): Promise<EquityPrice | null> {
    const key = `${chainId}:${feed.toLowerCase()}`;
    const cached = this.priceCache.get(key);
    if (cached && now - cached.at < this.ttlMs) return cached.value;

    const client = this.clientFor(chainId);
    if (!client) return null;

    const decimals = await this.decimalsOf(client, feed);
    if (decimals === null) return null;

    try {
      const round = (await client.readContract({
        address: feed as Address,
        abi: AGGREGATOR_V3_ABI,
        functionName: "latestRoundData",
      })) as readonly [bigint, bigint, bigint, bigint, bigint];

      const answer = round[1];
      const updatedAt = Number(round[3]);

      // Zero or negative is not a price. Chainlink flags this explicitly for
      // tokenized equities in thin sessions.
      if (answer <= 0n || updatedAt <= 0) return null;

      const priceUsd = Number(answer) / 10 ** decimals;
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

      const value: EquityPrice = {
        priceUsd,
        asOf: new Date(updatedAt * 1000),
        stale: now / 1000 - updatedAt > this.maxStalenessSeconds,
      };
      this.priceCache.set(key, { value, at: now });
      return value;
    } catch (error) {
      logger.warn("Equity price read failed", {
        chainId,
        feed,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
