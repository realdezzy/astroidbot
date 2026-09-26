import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { InternalMarketDataProvider } from "./internalProvider.js";
import { DexScreenerMarketDataProvider } from "./dexScreenerProvider.js";
import { GeckoTerminalMarketDataProvider } from "./geckoTerminalProvider.js";
import type { ChainId } from "../../types/chain.js";
import type { MarketDataProvider, TokenMarketData } from "./types.js";

export type { MarketDataProvider, TokenMarketData } from "./types.js";
export { InternalMarketDataProvider } from "./internalProvider.js";
export { DexScreenerMarketDataProvider } from "./dexScreenerProvider.js";
export { GeckoTerminalMarketDataProvider } from "./geckoTerminalProvider.js";

/** Said once per process: a mismatch is a configuration fact, not a per-call event. */
let warnedAboutPairing = false;

/**
 * Resolves the configured market-data source.
 *
 * `MARKET_DATA_PROVIDER`:
 *   - "internal"      — our swap index only. What `INDEXER_MODE=full` pairs with.
 *   - "dexscreener"   — third-party only. Development, for exercising the
 *                       interface before the index has data.
 *   - "auto"          — internal, falling back to DexScreener per chain when we
 *                       have nothing indexed for it yet.
 *   - "geckoterminal" — GeckoTerminal / CoinGecko onchain only, no fallback.
 *   - "hybrid"        — GeckoTerminal with DexScreener behind it. The setting
 *                       the hybrid architecture is named for.
 *
 * "auto" exists for the migration window: enabling a new chain means its index
 * starts empty, and a discovery page that is blank for a day looks broken.
 *
 * "hybrid" is a different bet, not a stronger "auto". It says the index is no
 * longer ingesting swaps at all (`INDEXER_MODE=discovery`), so there is no
 * internal price to prefer — pool discovery and liquidity still come from our
 * own logs, and everything derived from swaps is bought. Both of these put a
 * third party in the request path; the difference is that under "auto" that is
 * a temporary state and under "hybrid" it is the design.
 */
export function resolveMarketDataProvider(): MarketDataProvider {
  const config = ConfigManager.getInstance().config;
  const mode = config.MARKET_DATA_PROVIDER;

  // The one combination that fails silently. `internal` and `auto` read
  // metrics the *rollup* writes, and the rollup derives them from candles —
  // which `INDEXER_MODE=discovery` does not produce. Nothing errors: the
  // discovery page renders, with a price column frozen at whatever the last
  // full pass left behind and ageing invisibly. Said once, loudly, because
  // the two settings live in different halves of the file and are set by
  // different people.
  if ((mode === "internal" || mode === "auto") && config.INDEXER_MODE !== "full" && !warnedAboutPairing) {
    warnedAboutPairing = true;
    logger.warn("[marketData] provider reads the swap index, but the indexer is not ingesting swaps", {
      marketDataProvider: mode,
      indexerMode: config.INDEXER_MODE,
      hint: 'Use MARKET_DATA_PROVIDER="hybrid" with INDEXER_MODE="discovery", or INDEXER_MODE="full" with "internal".',
    });
  }

  switch (mode) {
    case "dexscreener":
      return new DexScreenerMarketDataProvider();
    case "auto":
      return new FallbackMarketDataProvider(
        new InternalMarketDataProvider(),
        new DexScreenerMarketDataProvider()
      );
    case "geckoterminal":
      return new GeckoTerminalMarketDataProvider();
    case "hybrid":
      return new FallbackMarketDataProvider(
        new GeckoTerminalMarketDataProvider(),
        new DexScreenerMarketDataProvider()
      );
    case "internal":
    default:
      return new InternalMarketDataProvider();
  }
}

/**
 * Whether the configured provider reads an external API rather than our index.
 *
 * The candle and trade sources default to following this: a chart drawn from
 * our own candles under a price column bought from an aggregator is two
 * different worlds stacked on one page, and they disagree visibly.
 */
export function marketDataIsExternal(): boolean {
  const mode = ConfigManager.getInstance().config.MARKET_DATA_PROVIDER;
  return mode === "geckoterminal" || mode === "hybrid";
}

/**
 * Primary provider with a per-chain fallback.
 *
 * The fallback triggers on *absence*, not on error: if the primary returns
 * nothing for a token, the secondary is asked. An error from the primary is
 * propagated instead, because "the database is down" should surface as a
 * failure rather than be silently papered over with third-party numbers.
 */
export class FallbackMarketDataProvider implements MarketDataProvider {
  readonly name: string;

  constructor(
    private readonly primary: MarketDataProvider,
    private readonly secondary: MarketDataProvider
  ) {
    this.name = `${primary.name}+${secondary.name}`;
  }

  supportsChain(chainId: ChainId): boolean {
    return this.primary.supportsChain(chainId) || this.secondary.supportsChain(chainId);
  }

  async getMarketData(
    chainId: ChainId,
    contractIds: string[]
  ): Promise<Map<string, TokenMarketData>> {
    const primary = this.primary.supportsChain(chainId)
      ? await this.primary.getMarketData(chainId, contractIds)
      : new Map<string, TokenMarketData>();

    // Only ask the secondary about what the primary couldn't answer.
    const missing = contractIds.filter((id) => {
      const hit = primary.get(id.toLowerCase());
      return !hit || hit.priceUsd == null;
    });

    if (missing.length === 0 || !this.secondary.supportsChain(chainId)) return primary;

    try {
      const secondary = await this.secondary.getMarketData(chainId, missing);
      for (const [key, value] of secondary) {
        if (!primary.has(key)) primary.set(key, value);
      }
    } catch (error) {
      logger.debug("[marketData] fallback provider failed", {
        chainId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return primary;
  }

  async search(query: string, chainId?: ChainId): Promise<TokenMarketData[]> {
    const primary = await this.primary.search(query, chainId);
    if (primary.length > 0) return primary;

    try {
      return await this.secondary.search(query, chainId);
    } catch {
      return [];
    }
  }

  async topTokens(chainId: ChainId, limit: number): Promise<TokenMarketData[]> {
    const primary = (await this.primary.topTokens?.(chainId, limit)) ?? [];
    if (primary.length > 0) return primary;
    return (await this.secondary.topTokens?.(chainId, limit)) ?? [];
  }
}
