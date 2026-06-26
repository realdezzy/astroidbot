import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface ChartData {
  name: string;
  value: number;
  color: string;
}

const COLORS = [
  "#5b8def",
  "#4ade80",
  "#fbbf24",
  "#f87171",
  "#a78bfa",
  "#2dd4bf",
  "#fb923c",
  "#f472b6",
];

interface PortfolioChartProps {
  data: ChartData[];
  totalValue: number;
}

export function PortfolioChart({ data, totalValue }: PortfolioChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        No portfolio data
      </div>
    );
  }

  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={70}
            outerRadius={110}
            paddingAngle={3}
            dataKey="value"
          >
            {data.map((_, index) => (
              <Cell
                key={index}
                fill={COLORS[index % COLORS.length]}
                stroke="transparent"
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: "#1f2937",
              border: "1px solid #374151",
              borderRadius: "8px",
              color: "#f3f4f6",
            }}
            formatter={(value: number) =>
              `$${value.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
            }
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="text-center">
          <p className="text-2xl font-bold text-white">
            ${totalValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </p>
          <p className="text-xs text-gray-400">Portfolio Value</p>
        </div>
      </div>
    </div>
  );
}
