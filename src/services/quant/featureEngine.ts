import { CandleService, type CandleData } from "./candleService.js";
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
  historicalVolatility: number; // Annualised std of log returns
  atr: number;
  bollingerWidth: number; // (upper - lower) / middle
  // Current price
  currentPrice: number;
}

export class FeatureEngine {
  private static instance: FeatureEngine;

  private constructor() {}

  static getInstance(): FeatureEngine {
    if (!FeatureEngine.instance) {
      FeatureEngine.instance = new FeatureEngine();
    }
    return FeatureEngine.instance;
  }

  async compute(token: string): Promise<Features> {
    const registry = DEXRegistry.getInstance();
    const [candles, currentPrice] = await Promise.all([
      CandleService.getInstance().getCandles(token.toUpperCase(), "5m", 200),
      registry.getTokenPrice(token).catch(() => 0),
    ]);

    if (candles.length < 30 || currentPrice === 0) {
      return this.emptyFeatures(currentPrice);
    }

    const closePrices = candles.map((c) => c.close);

    return {
      currentPrice,
      return1h: this.periodReturn(closePrices, 12), // 12 * 5m = 1h
      return4h: this.periodReturn(closePrices, 48), // 48 * 5m = 4h
      return24h: this.periodReturn(closePrices, 288), // 288 * 5m = 24h (cap to candles.length if needed)
      return7d: this.periodReturn(closePrices, candles.length - 1),
      rsi14: this.rsi(closePrices, 14),
      macdHistogram: this.macdHistogram(closePrices),
      vwapDistance: this.vwapDistance(candles),
      sma20: this.sma(closePrices, 20),
      ema12: this.ema(closePrices, 12),
      ema26: this.ema(closePrices, 26),
      historicalVolatility: this.historicalVol(closePrices, 30),
      atr: this.atr(candles, 14),
      bollingerWidth: this.bollingerWidth(closePrices, 20),
    };
  }

  // Returns ratio of change over the last N periods.
  private periodReturn(prices: number[], n: number): number {
    if (prices.length === 0) return 0;
    const lookback = Math.min(prices.length - 1, n);
    const start = prices[prices.length - 1 - lookback]!;
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

  // Exponential Moving Average.
  private ema(prices: number[], periods: number): number {
    if (prices.length === 0) return 0;
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
    const macdSeries: number[] = [];
    for (let i = Math.max(0, prices.length - 35); i < prices.length; i++) {
      const slice = prices.slice(0, i + 1);
      macdSeries.push(this.ema(slice, 12) - this.ema(slice, 26));
    }
    const signalLine = this.ema(macdSeries, 9);
    return macdLine - signalLine;
  }

  // Volume-weighted average price (VWAP) using real candle prices and volumes.
  private vwapDistance(candles: CandleData[]): number {
    if (candles.length === 0) return 0;
    let totalPV = 0;
    let totalVolume = 0;

    for (const c of candles) {
      const typicalPrice = (c.high + c.low + c.close) / 3;
      totalPV += typicalPrice * c.volume;
      totalVolume += c.volume;
    }

    if (totalVolume === 0) return 0;
    const vwap = totalPV / totalVolume;
    const lastPrice = candles[candles.length - 1]!.close;
    return (lastPrice - vwap) / vwap;
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
    // Annualise assuming 5-minute candles (105120 periods per year)
    return Math.sqrt(variance) * Math.sqrt(105120);
  }

  // Real Average True Range calculation using high/low/close.
  private atr(candles: CandleData[], periods: number): number {
    if (candles.length < 2) return 0;

    const trueRanges: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i]!;
      const prev = candles[i - 1]!;
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close)
      );
      trueRanges.push(tr);
    }

    return this.ema(trueRanges, periods);
  }

  // Bollinger Band width = (upper - lower) / SMA.
  private bollingerWidth(prices: number[], periods: number): number {
    const slice = prices.slice(-periods);
    if (slice.length < periods) return 0;
    const mean = slice.reduce((s, p) => s + p, 0) / slice.length;
    const std = Math.sqrt(slice.reduce((s, p) => s + (p - mean) ** 2, 0) / slice.length);
    if (mean === 0) return 0;
    return (2 * 2 * std) / mean; // 2 standard deviations
  }

  private emptyFeatures(currentPrice: number): Features {
    return {
      currentPrice,
      return1h: 0,
      return4h: 0,
      return24h: 0,
      return7d: 0,
      rsi14: 50,
      macdHistogram: 0,
      vwapDistance: 0,
      sma20: currentPrice,
      ema12: currentPrice,
      ema26: currentPrice,
      historicalVolatility: 0,
      atr: 0,
      bollingerWidth: 0,
    };
  }
}
