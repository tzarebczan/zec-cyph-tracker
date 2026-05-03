"use client"

import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from "recharts"

interface DataPoint {
  date: string
  cyph: number
  zec: number
  ratio: number | null
  timestamp: number
}

interface PriceChartProps {
  data: DataPoint[]
}

const CYPH_COLOR = "#34d399" // emerald-400
const ZEC_COLOR = "#fb923c"  // orange-400
const RATIO_COLOR = "#38bdf8" // sky-400

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-border bg-card/95 backdrop-blur-sm p-3 shadow-xl text-xs font-mono">
      <p className="text-muted-foreground mb-2">{label}</p>
      {payload.map((entry: { name: string; value: number; color: string }) => (
        <div key={entry.name} className="flex justify-between gap-6">
          <span style={{ color: entry.color }}>
            {entry.name === "ratio"
              ? "Ratio (CYPH/ZEC)"
              : entry.name.toUpperCase()}
          </span>
          <span className="text-foreground font-semibold">
            {entry.name === "ratio"
              ? entry.value != null
                ? entry.value.toFixed(6)
                : "—"
              : entry.name === "cyph"
              ? entry.value < 1
                ? `$${entry.value.toFixed(4)}`
                : `$${entry.value.toFixed(2)}`
              : `$${entry.value.toFixed(2)}`}
          </span>
        </div>
      ))}
    </div>
  )
}

export function PriceChart({ data }: PriceChartProps) {
  // ZEC is ~$30-60, CYPH is tiny — we need dual Y axes
  // Left axis: ZEC price, Right axis: CYPH price & ratio
  const avgRatio =
    data.length > 0
      ? data.reduce((sum, d) => sum + (d.ratio ?? 0), 0) / data.length
      : null

  return (
    <div className="w-full h-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
        >
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
          {/* Left Y axis — ZEC */}
          <YAxis
            yAxisId="zec"
            orientation="left"
            tick={{ fill: ZEC_COLOR, fontSize: 10, fontFamily: "monospace" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => `$${v.toFixed(0)}`}
            width={52}
          />
          {/* Right Y axis — CYPH */}
          <YAxis
            yAxisId="cyph"
            orientation="right"
            tick={{ fill: CYPH_COLOR, fontSize: 10, fontFamily: "monospace" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) =>
              v < 1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`
            }
            width={58}
          />
          {/* Far-right axis — Ratio (hidden ticks, same side as CYPH but scaled) */}
          <YAxis
            yAxisId="ratio"
            orientation="right"
            tick={{ fill: RATIO_COLOR, fontSize: 9, fontFamily: "monospace" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => v.toFixed(5)}
            width={0}
            hide
          />

          <Tooltip content={<CustomTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: 11, fontFamily: "monospace" }}
            formatter={(value) => {
              if (value === "cyph") return <span style={{ color: CYPH_COLOR }}>$CYPH</span>
              if (value === "zec") return <span style={{ color: ZEC_COLOR }}>$ZEC</span>
              if (value === "ratio") return <span style={{ color: RATIO_COLOR }}>CYPH/ZEC Ratio</span>
              return value
            }}
          />

          {avgRatio != null && (
            <ReferenceLine
              yAxisId="ratio"
              y={avgRatio}
              stroke={RATIO_COLOR}
              strokeDasharray="6 3"
              strokeOpacity={0.3}
              label={{
                value: "avg",
                fill: RATIO_COLOR,
                fontSize: 9,
                fontFamily: "monospace",
              }}
            />
          )}

          <Line
            yAxisId="zec"
            type="monotone"
            dataKey="zec"
            stroke={ZEC_COLOR}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: ZEC_COLOR }}
          />
          <Line
            yAxisId="cyph"
            type="monotone"
            dataKey="cyph"
            stroke={CYPH_COLOR}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: CYPH_COLOR }}
          />
          <Line
            yAxisId="ratio"
            type="monotone"
            dataKey="ratio"
            stroke={RATIO_COLOR}
            strokeWidth={1.5}
            strokeDasharray="5 2"
            dot={false}
            activeDot={{ r: 3, fill: RATIO_COLOR }}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
