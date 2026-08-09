import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { InternalMarketDataProvider } from "./internalProvider.js";
import { DexScreenerMarketDataProvider } from "./dexScreenerProvider.js";
import type { ChainId } from "../../types/chain.js";
import type { MarketDataProvider, TokenMarketData } from "./types.js";

export type { MarketDataProvider, TokenMarketData } from "./types.js";
export { InternalMarketDataProvider } from "./internalProvider.js";
export { DexScreenerMarketDataProvider } from "./dexScreenerProvider.js";

/**
 * Resolves the configured market-data source.
 *
 * `MARKET_DATA_PROVIDER`:
 *   - "internal"    — our swap index only. The production setting.
 *   - "dexscreener" — third-party only. Development, for exercising the
 *                     interface before the index has data.
 *   - "auto"        — internal, falling back to DexScreener per chain when we
 *                     have nothing indexed for it yet.
 *
 * "auto" exists for the migration window: enabling a new chain means its index
 * starts empty, and a discovery page that is blank for a day looks broken.
 * It is not a production end state — the fallback puts a third party back in
 * the request path, which is the dependency this whole subsystem removes.
 */
export function resolveMarketDataProvider(): MarketDataProvider {
  const mode = ConfigManager.getInstance().config.MARKET_DATA_PROVIDER;

  switch (mode) {
    case "dexscreener":
      return new DexScreenerMarketDataProvider();
    case "auto":
      return new FallbackMarketDataProvider(
        new InternalMarketDataProvider(),
        new DexScreenerMarketDataProvider()
      );
    case "internal":
    default:
      return new InternalMarketDataProvider();
  }
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
