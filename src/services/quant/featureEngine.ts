import { PriceHistoryService } from "../priceHistory.js";
import { DEXRegistry } from "../dex/dexRegistry.js";
import { logger } from "../../utils/logger.js";

export interface Features {
  // Multi-timeframe returns (fraction, not %)
  return1h: number;
  return4h: number;
  return24h: number;
  return7d: number;
  // Oscillators
  rsi14: number;
  macdHistogram: number;
  // Trend
  vwapDistance: number; // (price - vwap) / vwap
  sma20: number;
  ema12: number;
  ema26: number;
  // Volatility
  historicalVolatility: number; // Annualised std of log returns over 30 periods
  atr: number;
  bollingerWidth: number; // (upper - lower) / middle
  // Current price
  currentPrice: number;
}

export class FeatureEngine {
  private static instance: FeatureEngine;
  private priceHistory = PriceHistoryService.getInstance();

  private constructor() {}

  static getInstance(): FeatureEngine {
    if (!FeatureEngine.instance) {
      FeatureEngine.instance = new FeatureEngine();
    }
    return FeatureEngine.instance;
  }

  async compute(token: string): Promise<Features> {
    const [prices, currentPrice] = await Promise.all([
      this.priceHistory.getHistory(token, 500),
      DEXRegistry.getInstance().getTokenPrice(token).catch(() => 0),
    ]);

    if (prices.length < 2 || currentPrice === 0) {
      return this.emptyFeatures(currentPrice);
    }

    const last = prices[prices.length - 1]!;

    return {
      currentPrice,
      return1h: this.periodReturn(prices, 60),
      return4h: this.periodReturn(prices, 240),
      return24h: this.periodReturn(prices, 1440),
      return7d: this.periodReturn(prices, 10080),
      rsi14: this.rsi(prices, 14),
      macdHistogram: this.macdHistogram(prices),
      vwapDistance: this.vwapDistance(prices),
      sma20: this.sma(prices, 20),
      ema12: this.ema(prices, 12),
      ema26: this.ema(prices, 26),
      historicalVolatility: this.historicalVol(prices, 30),
      atr: this.atr(prices, 14),
      bollingerWidth: this.bollingerWidth(prices, 20),
    };
  }

  // Returns ratio of change over the last N periods.
  private periodReturn(prices: number[], n: number): number {
    if (prices.length <= n) return 0;
    const start = prices[prices.length - 1 - n]!;
    const end = prices[prices.length - 1]!;
    if (start === 0) return 0;
    return (end - start) / start;
  }

  // Wilder's RSI over N periods.
  private rsi(prices: number[], periods: number): number {
    if (prices.length < periods + 1) return 50;

    const slice = prices.slice(-(periods + 1));
    let gain = 0;
    let loss = 0;

    for (let i = 1; i < slice.length; i++) {
      const delta = slice[i]! - slice[i - 1]!;
      if (delta > 0) gain += delta;
      else loss -= delta;
    }

    const avgGain = gain / periods;
    const avgLoss = loss / periods;
    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  // Exponential Moving Average via the standard multiplier formula.
  private ema(prices: number[], periods: number): number {
    if (prices.length < periods) return prices[prices.length - 1] ?? 0;
    const k = 2 / (periods + 1);
    const slice = prices.slice(-Math.min(prices.length, periods * 3));
    let ema = slice[0]!;
    for (let i = 1; i < slice.length; i++) {
      ema = slice[i]! * k + ema * (1 - k);
    }
    return ema;
  }

  // Simple Moving Average.
  private sma(prices: number[], periods: number): number {
    const slice = prices.slice(-periods);
    if (slice.length === 0) return 0;
    return slice.reduce((s, p) => s + p, 0) / slice.length;
  }

  // MACD histogram = MACD line (EMA12 - EMA26) minus signal line (EMA9 of MACD).
  private macdHistogram(prices: number[]): number {
    if (prices.length < 35) return 0;
    const macdLine = this.ema(prices, 12) - this.ema(prices, 26);
    // Approximate signal by applying EMA9 to the last 35-period set of MACD values.
    const macdSeries: number[] = [];
    for (let i = Math.max(0, prices.length - 35); i < prices.length; i++) {
      const slice = prices.slice(0, i + 1);
      macdSeries.push(this.ema(slice, 12) - this.ema(slice, 26));
    }
    const signalLine = this.ema(macdSeries, 9);
    return macdLine - signalLine;
  }

  // Volume-weighted average price using price as proxy for volume (equal weighting).
  private vwapDistance(prices: number[]): number {
    if (prices.length === 0) return 0;
    const vwap = prices.reduce((s, p) => s + p, 0) / prices.length;
    const last = prices[prices.length - 1]!;
    return vwap === 0 ? 0 : (last - vwap) / vwap;
  }

  // Annualised historical volatility using standard deviation of log returns.
  private historicalVol(prices: number[], periods: number): number {
    const slice = prices.slice(-periods);
    if (slice.length < 2) return 0;

    const logReturns: number[] = [];
    for (let i = 1; i < slice.length; i++) {
      if (slice[i - 1]! > 0) {
        logReturns.push(Math.log(slice[i]! / slice[i - 1]!));
      }
    }

    if (logReturns.length < 2) return 0;
    const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
    const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / logReturns.length;
    // Annualise assuming polling interval approximates minutes in trading.
    return Math.sqrt(variance) * Math.sqrt(525600);
  }

  // Average True Range approximation (no high/low data — uses |close - prev close|).
  private atr(prices: number[], periods: number): number {
    const slice = prices.slice(-(periods + 1));
    if (slice.length < 2) return 0;
    const trueRanges: number[] = [];
    for (let i = 1; i < slice.length; i++) {
      trueRanges.push(Math.abs(slice[i]! - slice[i - 1]!));
    }
    return trueRanges.reduce((s, r) => s + r, 0) / trueRanges.length;
  }

  // Bollinger Band width = (upper - lower) / SMA.
  private bollingerWidth(prices: number[], periods: number): number {
    const slice = prices.slice(-periods);
    if (slice.length < periods) return 0;
    const mean = slice.reduce((s, p) => s + p, 0) / slice.length;
    const std = Math.sqrt(slice.reduce((s, p) => s + (p - mean) ** 2, 0) / slice.length);
    if (mean === 0) return 0;
    return (2 * 2 * std) / mean; // 2 standard deviations upper and lower
  }

  private emptyFeatures(currentPrice: number): Features {
    return {
      currentPrice,
      return1h: 0, return4h: 0, return24h: 0, return7d: 0,
      rsi14: 50, macdHistogram: 0, vwapDistance: 0,
      sma20: currentPrice, ema12: currentPrice, ema26: currentPrice,
      historicalVolatility: 0, atr: 0, bollingerWidth: 0,
    };
  }
}
