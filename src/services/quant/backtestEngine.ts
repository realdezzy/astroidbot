import { DatabaseService } from "../db.js";
import { logger } from "../../utils/logger.js";

export interface BacktestParams {
  chainId?: string;
  token: string;
  timeframe: string;
  startDate: Date;
  endDate: Date;
  initialCapitalUsd: number;
  strategyType: "momentum" | "breakout" | "mean_reversion";
  config?: Record<string, unknown>;
}

export interface BacktestResult {
  token: string;
  strategyType: string;
  initialCapitalUsd: number;
  finalCapitalUsd: number;
  totalReturnPct: number;
  tradesCount: number;
  winRatePct: number;
  maxDrawdownPct: number;
  trades: Array<{
    timestamp: Date;
    type: "BUY" | "SELL";
    price: number;
    amountUsd: number;
    capitalAfter: number;
  }>;
}

export class BacktestEngine {
  private static instance: BacktestEngine;

  static getInstance(): BacktestEngine {
    if (!BacktestEngine.instance) {
      BacktestEngine.instance = new BacktestEngine();
    }
    return BacktestEngine.instance;
  }

  async runBacktest(params: BacktestParams): Promise<BacktestResult> {
    const db = DatabaseService.getInstance();
    const chainId = params.chainId ?? "stacks:mainnet";

    const candles = await db.prisma.candle.findMany({
      where: {
        chainId,
        token: params.token,
        timeframe: params.timeframe,
        timestamp: {
          gte: params.startDate,
          lte: params.endDate,
        },
      },
      orderBy: { timestamp: "asc" },
    });

    if (candles.length < 5) {
      return {
        token: params.token,
        strategyType: params.strategyType,
        initialCapitalUsd: params.initialCapitalUsd,
        finalCapitalUsd: params.initialCapitalUsd,
        totalReturnPct: 0,
        tradesCount: 0,
        winRatePct: 0,
        maxDrawdownPct: 0,
        trades: [],
      };
    }

    let capital = params.initialCapitalUsd;
    let holdings = 0;
    let peakCapital = capital;
    let maxDrawdown = 0;
    let wins = 0;
    let totalTrades = 0;
    const trades: BacktestResult["trades"] = [];

    const prices = candles.map((c) => c.close);

    for (let i = 2; i < candles.length; i++) {
      const currentCandle = candles[i]!;
      const prevCandle = candles[i - 1]!;
      const price = currentCandle.close;

      let signal: "BUY" | "SELL" | "HOLD" = "HOLD";

      if (params.strategyType === "momentum") {
        const return1 = (prevCandle.close - candles[i - 2]!.close) / candles[i - 2]!.close;
        if (return1 > 0.02 && holdings === 0) signal = "BUY";
        else if (return1 < -0.01 && holdings > 0) signal = "SELL";
      } else if (params.strategyType === "breakout") {
        const highestPast = Math.max(...prices.slice(Math.max(0, i - 10), i));
        if (price > highestPast && holdings === 0) signal = "BUY";
        else if (price < prevCandle.close * 0.97 && holdings > 0) signal = "SELL";
      } else if (params.strategyType === "mean_reversion") {
        const slice = prices.slice(Math.max(0, i - 10), i);
        const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
        if (price < mean * 0.97 && holdings === 0) signal = "BUY";
        else if (price > mean * 1.03 && holdings > 0) signal = "SELL";
      }

      if (signal === "BUY" && capital > 0) {
        holdings = capital / price;
        capital = 0;
        totalTrades++;
        trades.push({
          timestamp: currentCandle.timestamp,
          type: "BUY",
          price,
          amountUsd: holdings * price,
          capitalAfter: holdings * price,
        });
      } else if (signal === "SELL" && holdings > 0) {
        const proceeds = holdings * price;
        const buyPrice = trades[trades.length - 1]?.price ?? price;
        if (price > buyPrice) wins++;
        capital = proceeds;
        holdings = 0;
        totalTrades++;
        trades.push({
          timestamp: currentCandle.timestamp,
          type: "SELL",
          price,
          amountUsd: proceeds,
          capitalAfter: capital,
        });
      }

      const totalEquity = capital + holdings * price;
      if (totalEquity > peakCapital) peakCapital = totalEquity;
      const drawdown = (peakCapital - totalEquity) / peakCapital;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    const finalCapital = capital + holdings * candles[candles.length - 1]!.close;
    const totalReturnPct = ((finalCapital - params.initialCapitalUsd) / params.initialCapitalUsd) * 100;
    const winRatePct = totalTrades > 0 ? (wins / (totalTrades / 2)) * 100 : 0;

    logger.info("Backtest complete", {
      token: params.token,
      totalTrades,
      totalReturnPct: totalReturnPct.toFixed(2),
    });

    return {
      token: params.token,
      strategyType: params.strategyType,
      initialCapitalUsd: params.initialCapitalUsd,
      finalCapitalUsd: Number(finalCapital.toFixed(2)),
      totalReturnPct: Number(totalReturnPct.toFixed(2)),
      tradesCount: totalTrades,
      winRatePct: Number(winRatePct.toFixed(2)),
      maxDrawdownPct: Number((maxDrawdown * 100).toFixed(2)),
      trades,
    };
  }
}
