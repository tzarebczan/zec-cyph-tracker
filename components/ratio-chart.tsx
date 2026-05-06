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
  /** Current live ratio (active-CYPH / live-ZEC) — drawn as a horizontal
   *  reference line so users can see at a glance how "right now" sits
   *  relative to the historical series + average. Includes extended-hours
   *  data when the dashboard's Ext. Hours toggle is on. */
  liveRatio?: number | null
  /** Whether liveRatio is sourced from a genuinely live tick (regular
   *  market open or freshest extended-hours print) vs. yesterday's close.
   *  Drives the marker label text. */
  liveIsRealtime?: boolean
}

const RATIO_COLOR = "#38bdf8"
// Foreground white for the live marker so it visually pops above the
// sky-blue area + dashed avg without inventing a new accent color.
const LIVE_COLOR = "#fafafa"

/**
 * Format a ratio value with enough significant figures to show meaningful differences.
 * E.g. 0.0000234 → "2.34e-5", 0.00234 → "0.00234", 1.234 → "1.234"
 */
function fmtRatio(v: number): string {
  if (v === 0) return "0"
  const abs = Math.abs(v)
  if (abs < 0.0001) return v.toExponential(3)
  if (abs < 0.01) return v.toFixed(6)
  if (abs < 1) return v.toFixed(4)
  return v.toFixed(4)
}

/**
 * For Y-axis ticks, show only enough digits to distinguish adjacent values.
 * We compute sig figs based on the range of data.
 */
function makeTickFormatter(min: number, max: number) {
  const range = max - min
  if (range === 0 || min === 0) return (v: number) => fmtRatio(v)
  // Find how many decimal places are needed to see ~1% of range
  const sigDecimals = Math.max(0, -Math.floor(Math.log10(range)) + 2)
  return (v: number) => {
    if (v === 0) return "0"
    const abs = Math.abs(v)
    if (abs < 0.0001) return v.toExponential(2)
    return v.toFixed(Math.min(sigDecimals, 8))
  }
}

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
          {val != null ? fmtRatio(val) : "—"}
        </span>
      </p>
    </div>
  )
}

export function RatioChart({ data, liveRatio, liveIsRealtime }: RatioChartProps) {
  const ratioValues = data
    .map((d) => d.ratio ?? 0)
    .filter((v) => v > 0)
  const avgRatio =
    ratioValues.length > 0
      ? ratioValues.reduce((a, b) => a + b, 0) / ratioValues.length
      : null

  // Include the live ratio in the y-domain so the marker doesn't get
  // clipped off the top/bottom when the realtime tick has moved outside
  // the historical range (common in extended hours).
  const liveR =
    typeof liveRatio === "number" && liveRatio > 0 ? liveRatio : null
  const allValues = liveR != null ? [...ratioValues, liveR] : ratioValues
  const minR = allValues.length > 0 ? Math.min(...allValues) : 0
  const maxR = allValues.length > 0 ? Math.max(...allValues) : 1
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
            tickFormatter={makeTickFormatter(minR, maxR)}
            width={80}
            domain={[minR - padding, maxR + padding]}
            tickCount={5}
          />
          <Tooltip content={<RatioTooltip />} />
          {avgRatio != null && (
            <ReferenceLine
              y={avgRatio}
              stroke={RATIO_COLOR}
              strokeDasharray="6 3"
              strokeOpacity={0.5}
              label={{
                value: `avg ${fmtRatio(avgRatio)}`,
                fill: RATIO_COLOR,
                fontSize: 9,
                fontFamily: "monospace",
                position: "insideTopRight",
              }}
            />
          )}
          {liveR != null && (
            <ReferenceLine
              y={liveR}
              stroke={LIVE_COLOR}
              strokeWidth={1.5}
              strokeOpacity={0.9}
              label={{
                value: `${liveIsRealtime ? "● live" : "● close"} ${fmtRatio(liveR)}`,
                fill: LIVE_COLOR,
                fontSize: 9,
                fontFamily: "monospace",
                position: "insideBottomRight",
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
