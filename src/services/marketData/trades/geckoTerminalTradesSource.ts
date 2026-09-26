import { GeckoTerminalService, geckoNetworkFor } from "../../geckoTerminal.js";
import type { SwapFeed, TokenTrader, TraderFeed, TradesSource } from "./types.js";

/** Said when the API has no pool for this token, rather than no trades. */
const NO_POOLS = "No pools found for this token on the market-data source.";

/** Said when the chain isn't one the external source covers at all. */
const UNSUPPORTED = "Trade activity is not available for this chain.";

/**
 * Activity from GeckoTerminal's per-pool trade feed.
 *
 * Scoped to the token's deepest pool rather than all of them. The endpoint is
 * per pool and a token can trade in a dozen, so covering all of them would be
 * a dozen calls against a budget measured per minute, for a panel showing
 * fifty rows — and the deepest pool is where the overwhelming majority of that
 * activity is anyway.
 *
 * The leaderboard is folded from the same feed. That is a real difference from
 * the internal source, which aggregates 24 hours of stored swaps: this one can
 * only rank the traders inside the page the API returns, so it is "top traders
 * among recent trades" rather than "top traders of the day". Stated here
 * because the column header cannot say it.
 */
export class GeckoTerminalTradesSource implements TradesSource {
  readonly name = "geckoterminal";

  private readonly api = GeckoTerminalService.getInstance();

  async recentSwaps(chainId: string, contractId: string, limit: number): Promise<SwapFeed> {
    if (!geckoNetworkFor(chainId)) return { swaps: [], note: UNSUPPORTED };

    const pool = await this.deepestPool(chainId, contractId);
    if (!pool) return { swaps: [], note: NO_POOLS };

    const trades = await this.api.trades(chainId, pool);

    return {
      swaps: trades.slice(0, limit).map((t) => ({
        txHash: t.txHash,
        timestamp: t.timestamp,
        isBuy: t.kind === "buy",
        volumeUsd: t.volumeUsd,
        priceUsd: t.priceUsd,
        traderAddress: t.traderAddress,
      })),
    };
  }

  async topTraders(chainId: string, contractId: string, limit: number): Promise<TraderFeed> {
    if (!geckoNetworkFor(chainId)) return { traders: [], note: UNSUPPORTED };

    const pool = await this.deepestPool(chainId, contractId);
    if (!pool) return { traders: [], note: NO_POOLS };

    const trades = await this.api.trades(chainId, pool);
    const byTrader = new Map<string, { volumeUsd: number | null; trades: number }>();

    for (const trade of trades) {
      if (!trade.traderAddress) continue;

      const entry = byTrader.get(trade.traderAddress) ?? { volumeUsd: null, trades: 0 };
      entry.trades += 1;
      // A trade the source couldn't value doesn't turn the running total into
      // a zero — it leaves it as whatever was actually known, and a trader all
      // of whose trades were unvalued keeps a null total rather than gaining a
      // $0 one that sorts them to the bottom as if they'd traded nothing.
      if (trade.volumeUsd !== null) {
        entry.volumeUsd = (entry.volumeUsd ?? 0) + trade.volumeUsd;
      }
      byTrader.set(trade.traderAddress, entry);
    }

    const traders: TokenTrader[] = [...byTrader.entries()]
      .map(([address, entry]) => ({ address, ...entry }))
      .sort((a, b) => (b.volumeUsd ?? 0) - (a.volumeUsd ?? 0))
      .slice(0, limit);

    return { traders };
  }

  /** The token's deepest pool — the one whose trades describe it. */
  private async deepestPool(chainId: string, contractId: string): Promise<string | null> {
    const pools = await this.api.topPools(chainId, contractId);

    return pools.reduce<{ address: string; reserve: number } | null>((best, pool) => {
      if (!pool.address) return best;
      const reserve = pool.reserveUsd ?? 0;
      return !best || reserve > best.reserve ? { address: pool.address, reserve } : best;
    }, null)?.address ?? null;
  }
}
