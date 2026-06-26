import { useEffect, useRef, useCallback } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type DeepPartial,
  type ChartOptions,
  type Time,
  AreaSeries,
  HistogramSeries,
  LineSeries,
  type AreaData,
  type HistogramData,
  type LineData,
} from "lightweight-charts";

type ChartType = "area" | "histogram" | "line";

interface ChartData {
  time: string;
  value: number;
}

interface Props {
  type: ChartType;
  data: ChartData[];
  height?: number;
  color?: string;
  title?: string;
}

function isLight(): boolean {
  return document.documentElement.classList.contains("light");
}

function getTheme(): DeepPartial<ChartOptions> {
  const light = isLight();
  return {
    layout: {
      background: { color: light ? "#f3f4f6" : "#030712" },
      textColor: light ? "#6b7280" : "#9ca3af",
    },
    grid: {
      vertLines: { color: light ? "rgba(229,231,235,0.8)" : "rgba(31,41,55,0.5)" },
      horzLines: { color: light ? "rgba(229,231,235,0.8)" : "rgba(31,41,55,0.5)" },
    },
    crosshair: {
      vertLine: {
        color: "#4f46e5",
        labelBackgroundColor: "#4f46e5",
      },
      horzLine: {
        color: "#4f46e5",
        labelBackgroundColor: "#4f46e5",
      },
    },
    timeScale: {
      borderColor: light ? "rgba(229,231,235,0.8)" : "rgba(31,41,55,0.5)",
      timeVisible: true,
    },
    rightPriceScale: {
      borderColor: light ? "rgba(229,231,235,0.8)" : "rgba(31,41,55,0.5)",
    },
  };
}

export function TradingViewChart({ type, data, height = 300, color = "#4f46e5", title }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area" | "Histogram" | "Line"> | null>(null);

  const createSeries = useCallback((chart: IChartApi): ISeriesApi<"Area" | "Histogram" | "Line"> => {
    switch (type) {
      case "area": {
        const s = chart.addSeries(AreaSeries, {
          lineColor: color,
          topColor: `${color}30`,
          bottomColor: `${color}00`,
          lineWidth: 2,
        });
        return s as unknown as ISeriesApi<"Area" | "Histogram" | "Line">;
      }
      case "histogram":
        return chart.addSeries(HistogramSeries, {
          color,
          base: 0,
        }) as unknown as ISeriesApi<"Area" | "Histogram" | "Line">;
      case "line":
        return chart.addSeries(LineSeries, {
          color,
          lineWidth: 2,
        }) as unknown as ISeriesApi<"Area" | "Histogram" | "Line">;
    }
  }, [type, color]);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      ...getTheme(),
      width: containerRef.current.clientWidth,
      height,
      handleScroll: false,
      handleScale: false,
    });

    chartRef.current = chart;

    const series = createSeries(chart);
    seriesRef.current = series;

    const mapped: Array<AreaData | HistogramData | LineData> = data.map((d) => ({
      time: d.time as Time,
      value: d.value,
    }));

    series.setData(mapped as any);
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Update data when it changes
  useEffect(() => {
    if (!seriesRef.current || data.length === 0) return;
    const mapped: Array<AreaData | HistogramData | LineData> = data.map((d) => ({
      time: d.time as Time,
      value: d.value,
    }));
    seriesRef.current.setData(mapped as any);
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  // React to theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (chartRef.current) {
        chartRef.current.applyOptions(getTheme());
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="w-full">
      {title && (
        <h3 className="text-sm font-bold text-title-text uppercase tracking-wider mb-4">{title}</h3>
      )}
      <div ref={containerRef} className="w-full rounded-lg overflow-hidden" style={{ height }} />
    </div>
  );
}
