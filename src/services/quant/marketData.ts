import type { TokenMarketSnapshot, MarketContext } from "../../types/market.js";
import { FeatureEngine } from "./featureEngine.js";
import { RegimeDetectionService } from "./regimeDetection.js";
import { isQuantEnabled } from "./quantMode.js";
import { DEXRegistry } from "../dex/dexRegistry.js";
import { logger } from "../../utils/logger.js";
import { chainDescriptor } from "../chains/walletChain.js";

// MarketDataService builds one MarketContext per chain per cycle.
// All strategies receive this context rather than fetching data independently.
export class MarketDataService {
  private static instance: MarketDataService;
  private featureEngine = FeatureEngine.getInstance();
  private regimeService = RegimeDetectionService.getInstance();

  // Refreshed once per cycle and cached per chain. This was a single slot, so
  // the first wallet of a cycle decided the context every other wallet got —
  // a Base strategy read the snapshots and regime built for Stacks tokens.
  private contextCache = new Map<string, { context: MarketContext; expiresAt: number }>();
  private readonly cacheTtlMs = 55_000; // Just under 60s poll interval.

  private constructor() {}

  static getInstance(): MarketDataService {
    if (!MarketDataService.instance) {
      MarketDataService.instance = new MarketDataService();
    }
    return MarketDataService.instance;
  }

  async getContext(tokens: string[], chainId: string): Promise<MarketContext> {
    const cached = this.contextCache.get(chainId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.context;
    }

    // With the quant layer off, a snapshot would be a full TokenMarketSnapshot
    // of placeholders — a $0 price, zero volatility, a zero ATR — handed to
    // strategies that have no way to tell it from a measurement. An absent
    // snapshot they do handle: every consumer reads the map with `.get()` and
    // already copes with a token that isn't in it.
    if (!isQuantEnabled()) {
      const context: MarketContext = {
        timestamp: Date.now(),
        snapshots: new Map<string, TokenMarketSnapshot>(),
        macroRegime: "UNKNOWN",
        correlationMatrix: new Map<string, Map<string, number>>(),
      };
      this.contextCache.set(chainId, { context, expiresAt: Date.now() + this.cacheTtlMs });
      return context;
    }

    const snapshots = new Map<string, TokenMarketSnapshot>();
    const registry = DEXRegistry.getInstance();
    const { nativeSymbol } = chainDescriptor(chainId);

    await Promise.all(
      tokens.map(async (token) => {
        try {
          const features = await this.featureEngine.compute(token, chainId);
          // Compute price impact as a proxy for pool depth, probing with the
          // chain's own native asset on the chain's own DEXs.
          const depthQuote = await registry.getBestQuote(nativeSymbol, token, 100, chainId).catch(() => null);
          const impactProxy = depthQuote?.quote.priceImpact ?? 0;
          // Safe trade size = 100 native / impact% gives a rough depth estimate.
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

    // Detect the macro regime using the chain's native asset as the reference.
    const macroToken = snapshots.has(nativeSymbol) ? nativeSymbol : tokens[0] ?? nativeSymbol;
    const macroRegime = await this.regimeService.detectRegime(macroToken, chainId);

    // Correlation matrix: computed as rolling Pearson correlation between token pairs.
    const correlationMatrix = await this.buildCorrelationMatrix(tokens, chainId);

    const context: MarketContext = {
      timestamp: Date.now(),
      snapshots,
      macroRegime,
      correlationMatrix,
    };

    this.contextCache.set(chainId, { context, expiresAt: Date.now() + this.cacheTtlMs });
    return context;
  }

  // Builds a pairwise Pearson correlation matrix over the last 60 price periods.
  private async buildCorrelationMatrix(tokens: string[], chainId: string): Promise<Map<string, Map<string, number>>> {
    const matrix = new Map<string, Map<string, number>>();
    const { PriceHistoryService } = await import("../priceHistory.js");
    const ph = PriceHistoryService.getInstance();

    const histories = await Promise.all(
      tokens.map(async (t) => ({ token: t, prices: await ph.getHistory(chainId, t, 60) }))
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
