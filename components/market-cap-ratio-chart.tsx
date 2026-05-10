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

// CYPH ÷ ZEC market cap, plotted as a percentage. Same chart shape as
// the price-ratio area chart on the dashboard, but framed as a mcap
// share — answers "how big is CYPH compared to ZEC, in mcap terms?"
// rather than "what's the spot exchange rate?".

interface DataPoint {
  date: string
  /** CYPH mcap ÷ ZEC mcap, expressed as a percentage so the axis ticks
   *  read naturally. e.g. 0.85 means CYPH is 0.85% of ZEC's mcap. */
  mcapRatioPct: number | null
}

interface Props {
  data: DataPoint[]
}

const RATIO_COLOR = "#38bdf8" // sky-400, matches the price-ratio chart

function fmtPct(v: number) {
  if (Math.abs(v) >= 100) return `${v.toFixed(0)}%`
  if (Math.abs(v) >= 10) return `${v.toFixed(1)}%`
  if (Math.abs(v) >= 1) return `${v.toFixed(2)}%`
  return `${v.toFixed(3)}%`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function McapTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const val = payload[0]?.value as number | null | undefined
  return (
    <div className="rounded-lg border border-border bg-card/95 backdrop-blur-sm p-3 shadow-xl text-xs font-mono">
      <p className="text-muted-foreground mb-1">{label}</p>
      <p style={{ color: RATIO_COLOR }}>
        CYPH ÷ ZEC mcap:{" "}
        <span className="text-foreground font-bold">
          {val != null ? fmtPct(val) : "—"}
        </span>
      </p>
    </div>
  )
}

export function MarketCapRatioChart({ data }: Props) {
  const values = data.flatMap((d) =>
    d.mcapRatioPct != null && d.mcapRatioPct > 0 ? [d.mcapRatioPct] : []
  )
  const avg =
    values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null
  const min = values.length > 0 ? Math.min(...values) : 0
  const max = values.length > 0 ? Math.max(...values) : 1
  const padding = (max - min) * 0.1 || max * 0.05 || 0.001

  return (
    <div className="w-full h-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
        >
          <defs>
            <linearGradient id="mcapRatioGrad" x1="0" y1="0" x2="0" y2="1">
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
            tickFormatter={(v: number) => fmtPct(v)}
            width={56}
            domain={[Math.max(0, min - padding), max + padding]}
            tickCount={5}
          />
          <Tooltip content={<McapTooltip />} />
          {avg != null && (
            <ReferenceLine
              y={avg}
              stroke={RATIO_COLOR}
              strokeDasharray="6 3"
              strokeOpacity={0.5}
              label={{
                value: `avg ${fmtPct(avg)}`,
                fill: RATIO_COLOR,
                fontSize: 9,
                fontFamily: "monospace",
                position: "insideTopRight",
              }}
            />
          )}
          <Area
            type="monotone"
            dataKey="mcapRatioPct"
            stroke={RATIO_COLOR}
            strokeWidth={2}
            fill="url(#mcapRatioGrad)"
            dot={false}
            activeDot={{ r: 4, fill: RATIO_COLOR }}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
