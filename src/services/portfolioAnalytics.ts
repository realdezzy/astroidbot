import { DatabaseService } from "./db.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { PortfolioManager } from "./portfolio.js";
import { CandleService, type CandleData } from "./quant/candleService.js";
import { walletChainId, walletDescriptor, groupByChainId } from "./chains/walletChain.js";
import { logger } from "../utils/logger.js";
import type { SwappableToken } from "../types.js";

/**
 * Historical portfolio valuation.
 *
 * Extracted from UserController.getAnalytics, and made chain-correct in the
 * process. The old version aggregated a user's holdings by *bare symbol*
 * across every wallet, so someone holding USDC on both Stacks and Base saw one
 * merged series priced against whichever chain answered first. Two different
 * assets, one number.
 *
 * Everything here is keyed by `chainId|SYMBOL` instead. That single change
 * propagates: balances, the reverse-reconstruction of historical positions,
 * candle lookups, and spot prices are all resolved against the chain the
 * holding actually lives on.
 */

export type Timeframe = "1d" | "7d" | "30d" | "all";

export interface AnalyticsPoint {
  date: string;
  timestamp: number;
  portfolioValue: number;
  pnl: number;
  volume: number;
  buys: number;
  sells: number;
}

export interface AnalyticsResult {
  summary: { totalTrades: number; totalVolume: number; totalProfit: number };
  chartData: AnalyticsPoint[];
}

interface Position {
  chainId: string;
  symbol: string;
  balance: number;
}

/** Composite key. The reason this module exists. */
function positionKey(chainId: string, symbol: string): string {
  return `${chainId}|${symbol.toUpperCase()}`;
}

function splitKey(key: string): { chainId: string; symbol: string } {
  const idx = key.lastIndexOf("|");
  return { chainId: key.slice(0, idx), symbol: key.slice(idx + 1) };
}

const TIMEFRAMES: Record<Timeframe, { candleTf: string; intervalMs: number; limit: number }> = {
  "1d": { candleTf: "1h", intervalMs: 60 * 60 * 1000, limit: 24 },
  "7d": { candleTf: "1d", intervalMs: 24 * 60 * 60 * 1000, limit: 7 },
  "30d": { candleTf: "1d", intervalMs: 24 * 60 * 60 * 1000, limit: 30 },
  all: { candleTf: "1d", intervalMs: 24 * 60 * 60 * 1000, limit: 30 },
};

export class PortfolioAnalyticsService {
  private static instance: PortfolioAnalyticsService;

  static getInstance(): PortfolioAnalyticsService {
    if (!PortfolioAnalyticsService.instance) {
      PortfolioAnalyticsService.instance = new PortfolioAnalyticsService();
    }
    return PortfolioAnalyticsService.instance;
  }

  async compute(userId: number, timeframe: Timeframe, walletId?: number): Promise<AnalyticsResult> {
    const db = DatabaseService.getInstance();
    const candleService = CandleService.getInstance();
    const now = new Date();

    const { candleTf, intervalMs } = TIMEFRAMES[timeframe];
    const limit = await this.resolveLimit(timeframe, userId, intervalMs, now);

    const periods: Date[] = [];
    for (let i = limit - 1; i >= 0; i--) {
      periods.push(candleService.getPeriodStart(now.getTime() - i * intervalMs, candleTf));
    }
    const startDate = periods[0]!;

    // Trades carry their wallet's chain so a trade can be attributed to the
    // right chain's position without a second lookup.
    const trades = await db.prisma.trade.findMany({
      where: {
        userId,
        status: "CONFIRMED",
        createdAt: { gte: startDate },
        ...(walletId ? { walletId } : {}),
      },
      orderBy: { createdAt: "asc" },
      include: { wallet: { select: { chain: true, chainFamily: true } } },
    });

    const allWallets = await db.findWalletsByUserId(userId);
    const wallets = walletId ? allWallets.filter((w) => w.id === walletId) : allWallets;

    const tokensByChain = await this.tokensByChain(wallets);
    const positions = await this.currentPositions(wallets, tokensByChain, userId);

    const candleMap = await this.loadCandles(positions, trades, candleTf, limit, candleService);

    const periodPositions = this.reconstructHistory(positions, trades, periods, limit);
    const periodTrades = this.bucketTrades(trades, periods, limit);

    const chartData = await this.buildChart(
      periodPositions,
      periodTrades,
      periods,
      limit,
      timeframe,
      candleMap
    );

    const baseline = chartData.length > 0 ? chartData[0]!.portfolioValue : 0;
    for (const point of chartData) {
      point.pnl = point.portfolioValue - baseline;
    }

    const totalVolume = chartData.reduce((sum, p) => sum + p.volume, 0);
    const totalProfit =
      chartData.length > 0 ? chartData[chartData.length - 1]!.portfolioValue - baseline : 0;

    return {
      summary: { totalTrades: trades.length, totalVolume, totalProfit },
      chartData,
    };
  }

  private async resolveLimit(
    timeframe: Timeframe,
    userId: number,
    intervalMs: number,
    now: Date
  ): Promise<number> {
    if (timeframe !== "all") return TIMEFRAMES[timeframe].limit;

    const oldest = await DatabaseService.getInstance().prisma.trade.findFirst({
      where: { userId, status: "CONFIRMED" },
      orderBy: { createdAt: "asc" },
    });
    if (!oldest) return 30;

    const days = Math.ceil((now.getTime() - oldest.createdAt.getTime()) / intervalMs);
    return Math.min(365, Math.max(1, days));
  }

  /** One token universe per chain — a wallet must be priced against its own. */
  private async tokensByChain(
    wallets: { chain?: string | null; chainFamily?: string | null }[]
  ): Promise<Map<string, SwappableToken[]>> {
    const registry = DEXRegistry.getInstance();
    const byChain = new Map<string, SwappableToken[]>();

    await Promise.all(
      [...groupByChainId(wallets).keys()].map(async (chainId) => {
        byChain.set(chainId, await registry.getSwappableTokens(false, chainId).catch(() => []));
      })
    );

    return byChain;
  }

  private async currentPositions(
    wallets: { id: number; address: string; balance: number; chain?: string | null; chainFamily?: string | null }[],
    tokensByChain: Map<string, SwappableToken[]>,
    userId: number
  ): Promise<Map<string, Position>> {
    const pm = PortfolioManager.getInstance();
    const positions = new Map<string, Position>();

    for (const wallet of wallets) {
      const chainId = walletChainId(wallet);
      const tokens = tokensByChain.get(chainId) ?? [];

      try {
        const balances = await pm.fetchBalances(wallet.address, tokens, userId, true, chainId);
        for (const b of balances) {
          this.addPosition(positions, chainId, b.symbol, b.balance);
        }
      } catch (err) {
        // Fall back to the wallet's cached native balance, on its own chain
        // rather than assuming STX. Logged, because a silent fallback here
        // looks identical to a healthy wallet holding only the native asset.
        logger.warn("Balance fetch failed, using cached wallet balance", {
          walletId: wallet.id,
          chainId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.addPosition(positions, chainId, walletDescriptor(wallet).nativeSymbol, wallet.balance);
      }
    }

    return positions;
  }

  private addPosition(
    positions: Map<string, Position>,
    chainId: string,
    symbol: string,
    balance: number
  ): void {
    const key = positionKey(chainId, symbol);
    const existing = positions.get(key);
    if (existing) {
      existing.balance += balance;
    } else {
      positions.set(key, { chainId, symbol: symbol.toUpperCase(), balance });
    }
  }

  private async loadCandles(
    positions: Map<string, Position>,
    trades: { tokenIn: string; tokenOut: string; wallet: { chain: string | null; chainFamily: string | null } }[],
    candleTf: string,
    limit: number,
    candleService: CandleService
  ): Promise<Map<string, CandleData[]>> {
    // Keyed by chainId|SYMBOL, so USDC on Stacks and USDC on Base fetch — and
    // cache — two genuinely different series.
    const wanted = new Set<string>();

    for (const p of positions.values()) {
      wanted.add(positionKey(p.chainId, p.symbol));
    }
    for (const t of trades) {
      const chainId = walletChainId(t.wallet);
      wanted.add(positionKey(chainId, t.tokenIn));
      wanted.add(positionKey(chainId, t.tokenOut));
    }

    const map = new Map<string, CandleData[]>();
    await Promise.all(
      [...wanted].map(async (key) => {
        const { chainId, symbol } = splitKey(key);
        try {
          map.set(key, await candleService.getCandles(symbol, candleTf, limit * 2, chainId));
        } catch (err) {
          logger.warn("Failed to fetch candles", { chainId, symbol, err });
        }
      })
    );

    return map;
  }

  /**
   * Walks trades backwards from today's balances to reconstruct what was held
   * at each period boundary. Keys stay chain-scoped throughout, so a Base
   * trade can never adjust a Stacks position of the same ticker.
   */
  private reconstructHistory(
    positions: Map<string, Position>,
    trades: {
      tokenIn: string;
      tokenOut: string;
      amountIn: number;
      amountOut: number;
      createdAt: Date;
      wallet: { chain: string | null; chainFamily: string | null };
    }[],
    periods: Date[],
    limit: number
  ): Map<string, number>[] {
    const running = new Map<string, number>();
    for (const [key, p] of positions) running.set(key, p.balance);

    const newestFirst = [...trades].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const result = new Array<Map<string, number>>(limit);
    let idx = 0;

    for (let j = limit - 1; j >= 0; j--) {
      const boundary = periods[j]!.getTime();

      while (idx < newestFirst.length && newestFirst[idx]!.createdAt.getTime() > boundary) {
        const trade = newestFirst[idx]!;
        const chainId = walletChainId(trade.wallet);
        const keyIn = positionKey(chainId, trade.tokenIn);
        const keyOut = positionKey(chainId, trade.tokenOut);

        // Reversing the trade: what was spent comes back, what was received
        // goes away.
        running.set(keyIn, (running.get(keyIn) ?? 0) + trade.amountIn);
        running.set(keyOut, Math.max(0, (running.get(keyOut) ?? 0) - trade.amountOut));

        idx++;
      }

      result[j] = new Map(running);
    }

    return result;
  }

  private bucketTrades<T extends { createdAt: Date }>(
    trades: T[],
    periods: Date[],
    limit: number
  ): T[][] {
    const buckets: T[][] = Array.from({ length: limit }, () => []);

    for (const trade of trades) {
      const t = trade.createdAt.getTime();
      for (let j = 0; j < limit; j++) {
        const start = periods[j]!.getTime();
        const end = j === limit - 1 ? Infinity : periods[j + 1]!.getTime();
        if (t >= start && t < end) {
          buckets[j]!.push(trade);
          break;
        }
      }
    }

    return buckets;
  }

  private async buildChart(
    periodPositions: Map<string, number>[],
    periodTrades: {
      tokenIn: string;
      amountIn: number;
      amountInUsd: number | null;
      direction: string;
      wallet: { chain: string | null; chainFamily: string | null };
    }[][],
    periods: Date[],
    limit: number,
    timeframe: Timeframe,
    candleMap: Map<string, CandleData[]>
  ): Promise<AnalyticsPoint[]> {
    const chart: AnalyticsPoint[] = [];

    for (let j = 0; j < limit; j++) {
      const at = periods[j]!;

      let portfolioValue = 0;
      for (const [key, balance] of periodPositions[j]!) {
        if (balance <= 0) continue;
        portfolioValue += balance * (await this.priceAt(key, at, candleMap));
      }

      let volume = 0;
      let buys = 0;
      let sells = 0;

      for (const trade of periodTrades[j]!) {
        volume += await this.tradeUsd(trade, at, candleMap);
        if (trade.direction === "BUY") buys++;
        else sells++;
      }

      chart.push({
        date: this.formatDate(at, timeframe),
        timestamp: at.getTime(),
        portfolioValue,
        pnl: 0,
        volume,
        buys,
        sells,
      });
    }

    return chart;
  }

  private async tradeUsd(
    trade: {
      tokenIn: string;
      amountIn: number;
      amountInUsd: number | null;
      wallet: { chain: string | null; chainFamily: string | null };
    },
    at: Date,
    candleMap: Map<string, CandleData[]>
  ): Promise<number> {
    // The recorded USD value is authoritative when present — it was computed
    // at execution time against the correct chain.
    if (trade.amountInUsd != null) return trade.amountInUsd;

    const key = positionKey(walletChainId(trade.wallet), trade.tokenIn);
    return trade.amountIn * (await this.priceAt(key, at, candleMap));
  }

  /**
   * Historical price for one chain's token.
   *
   * Falls back to a live quote scoped to the same chain, then to 0 — never to
   * an invented constant. The old code fell back to a hardcoded $2 for STX and
   * $1 for everything else, which silently valued any unpriced token at par.
   */
  private async priceAt(
    key: string,
    at: Date,
    candleMap: Map<string, CandleData[]>
  ): Promise<number> {
    const candles = candleMap.get(key) ?? [];

    if (candles.length > 0) {
      const target = at.getTime();
      const exact = candles.find((c) => c.timestamp.getTime() === target);
      if (exact) return exact.close;

      const before = candles.filter((c) => c.timestamp.getTime() <= target);
      if (before.length > 0) {
        return before.reduce((a, b) => (a.timestamp > b.timestamp ? a : b)).close;
      }
      return candles[0]!.close;
    }

    const { chainId, symbol } = splitKey(key);
    return DEXRegistry.getInstance().getTokenPrice(symbol, chainId).catch(() => 0);
  }

  private formatDate(at: Date, timeframe: Timeframe): string {
    if (timeframe === "1d") {
      return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    }
    return at.toISOString().split("T")[0]!;
  }
}
