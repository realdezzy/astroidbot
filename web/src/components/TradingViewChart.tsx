import { useEffect, useRef } from "react";
import { createChart, ColorType, CandlestickSeries, HistogramSeries } from "lightweight-charts";

export interface CandleData {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string | number;
}

interface TradingViewChartProps {
  candles: CandleData[];
  timeframe?: string;
  theme?: "dark" | "light";
}

export function TradingViewChart({ candles, timeframe = "5m", theme = "dark" }: TradingViewChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const isDark = theme === "dark";
    const backgroundColor = "transparent";
    const textColor = isDark ? "#94a3b8" : "#475569";
    const gridColor = isDark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)";

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: backgroundColor },
        textColor: textColor,
        fontSize: 11,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      },
      grid: {
        vertLines: { color: gridColor },
        horzLines: { color: gridColor },
      },
      crosshair: {
        mode: 1,
      },
      rightPriceScale: {
        borderColor: gridColor,
        autoScale: true,
      },
      timeScale: {
        borderColor: gridColor,
        timeVisible: true,
        secondsVisible: timeframe === "1s" || timeframe === "1m",
      },
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight || 420,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: "#3b82f6",
      priceFormat: {
        type: "volume",
      },
      priceScaleId: "",
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    // Format candle data for lightweight-charts
    const formattedCandles = candles.map((c) => {
      const timeInSec =
        typeof c.timestamp === "number"
          ? Math.floor(c.timestamp > 1e11 ? c.timestamp / 1000 : c.timestamp)
          : Math.floor(new Date(c.timestamp).getTime() / 1000);

      return {
        time: timeInSec as any,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      };
    });

    const formattedVolume = candles.map((c) => {
      const timeInSec =
        typeof c.timestamp === "number"
          ? Math.floor(c.timestamp > 1e11 ? c.timestamp / 1000 : c.timestamp)
          : Math.floor(new Date(c.timestamp).getTime() / 1000);

      return {
        time: timeInSec as any,
        value: c.volume,
        color: c.close >= c.open ? "rgba(16, 185, 129, 0.4)" : "rgba(239, 68, 68, 0.4)",
      };
    });

    if (formattedCandles.length > 0) {
      // Sort by time ascending
      formattedCandles.sort((a, b) => (a.time as number) - (b.time as number));
      formattedVolume.sort((a, b) => (a.time as number) - (b.time as number));

      candleSeries.setData(formattedCandles);
      volumeSeries.setData(formattedVolume);
      chart.timeScale().fitContent();
    }

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [candles, timeframe, theme]);

  return <div ref={chartContainerRef} className="w-full h-full min-h-[380px]" />;
}
