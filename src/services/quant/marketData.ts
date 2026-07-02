import type { TokenMarketSnapshot, MarketContext } from "../../types/market.js";
import { FeatureEngine } from "./featureEngine.js";
import { RegimeDetectionService } from "./regimeDetection.js";
import { DEXRegistry } from "../dex/dexRegistry.js";
import { logger } from "../../utils/logger.js";

// MarketDataService builds a single MarketContext per cycle.
// All strategies receive this context rather than fetching data independently.
export class MarketDataService {
  private static instance: MarketDataService;
  private featureEngine = FeatureEngine.getInstance();
  private regimeService = RegimeDetectionService.getInstance();

  // Full context is refreshed once per cycle and cached.
  private contextCache: { context: MarketContext; expiresAt: number } | null = null;
  private readonly cacheTtlMs = 55_000; // Just under 60s poll interval.

  private constructor() {}

  static getInstance(): MarketDataService {
    if (!MarketDataService.instance) {
      MarketDataService.instance = new MarketDataService();
    }
    return MarketDataService.instance;
  }

  async getContext(tokens: string[]): Promise<MarketContext> {
    if (this.contextCache && this.contextCache.expiresAt > Date.now()) {
      return this.contextCache.context;
    }

    const snapshots = new Map<string, TokenMarketSnapshot>();
    const registry = DEXRegistry.getInstance();

    await Promise.all(
      tokens.map(async (token) => {
        try {
          const features = await this.featureEngine.compute(token);
          // Compute price impact as a proxy for pool depth.
          const depthQuote = await registry.getBestQuote("STX", token, 100).catch(() => null);
          const impactProxy = depthQuote?.quote.priceImpact ?? 0;
          // Safe trade size = 100 STX / impact% gives a rough depth estimate.
          const poolDepth1PctUsd = impactProxy > 0 ? (100 / impactProxy) * features.currentPrice : 0;

          const snapshot: TokenMarketSnapshot = {
            token,
            currentPriceUsd: features.currentPrice,
            bidAskSpreadPct: impactProxy,
            poolLiquidityUsd: poolDepth1PctUsd,
            poolDepth1PctUsd,
            // Pool TVL and APR require an external DEX analytics API — set to 0 until integrated.
            poolTvlUsd: 0,
            poolApr: 0,
            volatility30m: features.historicalVolatility,
            volatility24h: features.historicalVolatility,
            atr: features.atr,
            bollingerWidth: features.bollingerWidth,
            return1h: features.return1h,
            return4h: features.return4h,
            return24h: features.return24h,
            return7d: features.return7d,
            rsi14: features.rsi14,
            macdHistogram: features.macdHistogram,
            vwapDistance: features.vwapDistance,
            // Volume data requires an external source — on-chain indexer integration planned.
            volume24hUsd: 0,
            volumeTrend: 1,
            buySellRatio: 1,
            // Whale tracking requires an on-chain indexer — planned for Phase 3.
            whaleTxCount24h: 0,
            netWhaleFlowUsd: 0,
            sentimentScore: 0,
          };

          snapshots.set(token, snapshot);
        } catch (err) {
          logger.warn("[MarketData] Failed to build snapshot", { token, error: err });
        }
      })
    );

    // Detect the macro regime using STX as the primary reference token.
    const macroToken = snapshots.has("STX") ? "STX" : tokens[0] ?? "STX";
    const macroRegime = await this.regimeService.detectRegime(macroToken);

    // Correlation matrix: computed as rolling Pearson correlation between token pairs.
    const correlationMatrix = await this.buildCorrelationMatrix(tokens);

    const context: MarketContext = {
      timestamp: Date.now(),
      snapshots,
      macroRegime,
      correlationMatrix,
    };

    this.contextCache = { context, expiresAt: Date.now() + this.cacheTtlMs };
    return context;
  }

  // Builds a pairwise Pearson correlation matrix over the last 60 price periods.
  private async buildCorrelationMatrix(tokens: string[]): Promise<Map<string, Map<string, number>>> {
    const matrix = new Map<string, Map<string, number>>();
    const { PriceHistoryService } = await import("../priceHistory.js");
    const ph = PriceHistoryService.getInstance();

    const histories = await Promise.all(
      tokens.map(async (t) => ({ token: t, prices: await ph.getHistory(t, 60) }))
    );

    for (const a of histories) {
      const row = new Map<string, number>();
      for (const b of histories) {
        if (a.token === b.token) {
          row.set(b.token, 1);
        } else {
          row.set(b.token, this.pearson(a.prices, b.prices));
        }
      }
      matrix.set(a.token, row);
    }

    return matrix;
  }

  private pearson(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    if (n < 2) return 0;

    const aSlice = a.slice(-n);
    const bSlice = b.slice(-n);

    const meanA = aSlice.reduce((s, v) => s + v, 0) / n;
    const meanB = bSlice.reduce((s, v) => s + v, 0) / n;

    let num = 0;
    let denA = 0;
    let denB = 0;

    for (let i = 0; i < n; i++) {
      const da = aSlice[i]! - meanA;
      const db = bSlice[i]! - meanB;
      num += da * db;
      denA += da * da;
      denB += db * db;
    }

    const denom = Math.sqrt(denA * denB);
    return denom === 0 ? 0 : num / denom;
  }
}
