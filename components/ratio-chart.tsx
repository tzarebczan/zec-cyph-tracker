"use client"

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts"

interface DataPoint {
  date: string
  ratio: number | null
}

interface RatioChartProps {
  data: DataPoint[]
}

const RATIO_COLOR = "#38bdf8"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function RatioTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const val = payload[0]?.value
  return (
    <div className="rounded-lg border border-border bg-card/95 backdrop-blur-sm p-3 shadow-xl text-xs font-mono">
      <p className="text-muted-foreground mb-1">{label}</p>
      <p style={{ color: RATIO_COLOR }}>
        CYPH/ZEC:{" "}
        <span className="text-foreground font-bold">
          {val != null ? val.toFixed(6) : "—"}
        </span>
      </p>
    </div>
  )
}

export function RatioChart({ data }: RatioChartProps) {
  const ratioValues = data
    .map((d) => d.ratio ?? 0)
    .filter((v) => v > 0)
  const avgRatio =
    ratioValues.length > 0
      ? ratioValues.reduce((a, b) => a + b, 0) / ratioValues.length
      : null

  const minR = ratioValues.length > 0 ? Math.min(...ratioValues) : 0
  const maxR = ratioValues.length > 0 ? Math.max(...ratioValues) : 1
  const padding = (maxR - minR) * 0.1 || 0.001

  return (
    <div className="w-full h-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
        >
          <defs>
            <linearGradient id="ratioGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={RATIO_COLOR} stopOpacity={0.3} />
              <stop offset="95%" stopColor={RATIO_COLOR} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.05)"
            vertical={false}
          />
          <XAxis
            dataKey="date"
            tick={{ fill: "#64748b", fontSize: 11, fontFamily: "monospace" }}
            axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: RATIO_COLOR, fontSize: 10, fontFamily: "monospace" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => v.toFixed(5)}
            width={64}
            domain={[minR - padding, maxR + padding]}
          />
          <Tooltip content={<RatioTooltip />} />
          {avgRatio != null && (
            <ReferenceLine
              y={avgRatio}
              stroke={RATIO_COLOR}
              strokeDasharray="6 3"
              strokeOpacity={0.5}
              label={{
                value: `avg ${avgRatio.toFixed(5)}`,
                fill: RATIO_COLOR,
                fontSize: 9,
                fontFamily: "monospace",
                position: "insideTopRight",
              }}
            />
          )}
          <Area
            type="monotone"
            dataKey="ratio"
            stroke={RATIO_COLOR}
            strokeWidth={2}
            fill="url(#ratioGrad)"
            dot={false}
            activeDot={{ r: 4, fill: RATIO_COLOR }}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
