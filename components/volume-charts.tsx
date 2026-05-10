"use client"

import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts"

// Compact 30-day daily-volume chart for the /stats Volume tab. Bars
// for daily volume (left axis, USD), thin line for ZEC price (right
// axis, USD), so users can read "did the price move on real volume?"
// at a glance. Stays in its own file so stats-client.tsx and the
// rankings tab don't drag Recharts into their bundle — this file gets
// dynamic-imported only when the Volume tab opens.

interface VolumePoint {
  ts: number
  date: string
  volume: number
  price: number
}

interface VolumeChartProps {
  data: VolumePoint[]
}

const ZEC_COLOR = "#fb923c"
const PRICE_COLOR = "#a78bfa" // violet — chosen to read distinctly from
//                                       the orange bars without clashing.
const MUTED_GRID = "rgba(255,255,255,0.05)"
const MUTED_AXIS = "rgba(255,255,255,0.08)"
const TICK_FILL = "#64748b"

function fmtAxisVol(v: number) {
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(0)}M`
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

function fmtFullVol(v: number) {
  if (Math.abs(v) >= 1e9)
    return `$${(v / 1e9).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}B`
  if (Math.abs(v) >= 1e6)
    return `$${(v / 1e6).toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}M`
  return `$${Math.round(v).toLocaleString("en-US")}`
}

export function VolumeChart({ data }: VolumeChartProps) {
  return (
    <div className="w-full h-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={MUTED_GRID}
            vertical={false}
          />
          <XAxis
            dataKey="date"
            tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }}
            axisLine={{ stroke: MUTED_AXIS }}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={32}
          />
          <YAxis
            yAxisId="vol"
            orientation="left"
            tick={{ fill: ZEC_COLOR, fontSize: 10, fontFamily: "monospace" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={fmtAxisVol}
            width={48}
          />
          <YAxis
            yAxisId="price"
            orientation="right"
            tick={{ fill: PRICE_COLOR, fontSize: 10, fontFamily: "monospace" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `$${v.toFixed(0)}`}
            width={44}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as VolumePoint
              return (
                <div className="rounded-lg border border-border bg-card/95 backdrop-blur-sm p-2 shadow-xl text-[11px] font-mono min-w-[12rem]">
                  <p className="text-muted-foreground mb-1">{String(label)}</p>
                  <div className="flex justify-between gap-4">
                    <span style={{ color: ZEC_COLOR }}>Volume</span>
                    <span className="text-foreground font-semibold">
                      {fmtFullVol(p.volume)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span style={{ color: PRICE_COLOR }}>$ZEC</span>
                    <span className="text-foreground font-semibold">
                      ${p.price.toFixed(2)}
                    </span>
                  </div>
                </div>
              )
            }}
          />
          <Bar
            yAxisId="vol"
            dataKey="volume"
            fill={ZEC_COLOR}
            radius={[2, 2, 0, 0]}
            isAnimationActive={false}
          />
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="price"
            stroke={PRICE_COLOR}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
