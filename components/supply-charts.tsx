"use client"

import { useState } from "react"
import useSWR from "swr"
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts"
import { TrendingUp, ShieldCheck, Info } from "lucide-react"

const ZEC_COLOR = "#fb923c"
const SHIELD_COLOR = "#34d399"
const TRANSPARENT_COLOR = "#475569"

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const json = await res.json()
  if (!res.ok) throw new Error(`Request failed: ${res.status}`)
  return json
}

interface ShieldedHistoryPoint {
  date: string
  total: number
  sapling: number
  orchard: number
  sprout: number
  lockbox: number
  transparent: number
  pct: number
}

interface ShieldedHistoryResponse {
  points: ShieldedHistoryPoint[]
  daysCollected: number
}

function fmtMcapShort(n: number) {
  const abs = Math.abs(n)
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(0)}M`
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

function fmtZecShort(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return n.toFixed(0)
}

function fmtDate(iso: string) {
  // YYYY-MM-DD → "Apr 14"
  const d = new Date(iso + "T00:00:00Z")
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
}

function fmtUnixDate(ms: number) {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
}

export function SupplyCharts({
  mcapSeries,
}: {
  mcapSeries: [number, number][] | null | undefined
}) {
  const [tab, setTab] = useState<"mcap" | "shielded">("mcap")

  const { data: history } = useSWR<ShieldedHistoryResponse>(
    "/api/zec-stats/history",
    fetcher,
    {
      refreshInterval: 5 * 60_000,
      keepPreviousData: true,
    }
  )

  const mcapPoints = (mcapSeries ?? []).map(([ts, mcap]) => ({
    ts,
    label: fmtUnixDate(ts),
    mcap,
  }))

  const shieldedPoints = (history?.points ?? []).map((p) => ({
    label: fmtDate(p.date),
    shielded: p.total,
    transparent: p.transparent,
    pct: p.pct,
  }))

  return (
    <section className="rounded-lg border border-border bg-card flex flex-col">
      {/* Tab bar */}
      <div className="flex items-center gap-0 border-b border-border">
        <ChartTab
          active={tab === "mcap"}
          onClick={() => setTab("mcap")}
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          label="Market cap · 30D"
        />
        <ChartTab
          active={tab === "shielded"}
          onClick={() => setTab("shielded")}
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
          label="Shielded supply"
        />
      </div>

      <div className="p-3">
        {tab === "mcap" ? (
          <McapChart points={mcapPoints} />
        ) : (
          <ShieldedChart
            points={shieldedPoints}
            daysCollected={history?.daysCollected ?? 0}
          />
        )}
      </div>
    </section>
  )
}

function ChartTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-xs font-mono font-semibold border-b-2 transition-colors ${
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

function McapChart({
  points,
}: {
  points: { ts: number; label: string; mcap: number }[]
}) {
  if (points.length < 2) {
    return (
      <div className="h-48 md:h-64 flex items-center justify-center text-xs font-mono text-muted-foreground">
        Loading market-cap history…
      </div>
    )
  }
  return (
    <div className="h-48 md:h-64">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={points}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        >
          <defs>
            <linearGradient id="mcap-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ZEC_COLOR} stopOpacity={0.35} />
              <stop offset="100%" stopColor={ZEC_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#1f2937" strokeDasharray="2 4" />
          <XAxis
            dataKey="label"
            tick={{ fill: "#64748b", fontSize: 10 }}
            stroke="#1f2937"
            interval="preserveStartEnd"
            minTickGap={32}
          />
          <YAxis
            tick={{ fill: "#64748b", fontSize: 10 }}
            stroke="#1f2937"
            tickFormatter={(v: number) => fmtMcapShort(v)}
            width={56}
            domain={["auto", "auto"]}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#0b0f14e6",
              border: "1px solid #1f2937",
              borderRadius: 8,
              fontFamily: "monospace",
              fontSize: 11,
            }}
            labelStyle={{ color: "#9ca3af" }}
            formatter={(v: number) => [fmtMcapShort(v), "Market cap"]}
          />
          <Area
            type="monotone"
            dataKey="mcap"
            stroke={ZEC_COLOR}
            strokeWidth={2}
            fill="url(#mcap-fill)"
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

function ShieldedChart({
  points,
  daysCollected,
}: {
  points: {
    label: string
    shielded: number
    transparent: number
    pct: number
  }[]
  daysCollected: number
}) {
  // Need at least two distinct days to draw a meaningful line.
  if (daysCollected < 2) {
    return (
      <div className="h-48 md:h-64 flex flex-col items-center justify-center gap-2 text-center px-4">
        <ShieldCheck className="h-6 w-6 text-emerald-400/70" />
        <p className="text-xs font-mono text-foreground">
          Shielded history accumulating
        </p>
        <p className="text-[11px] font-mono text-muted-foreground max-w-sm leading-relaxed">
          {daysCollected === 0
            ? "Today is day 1. Each daily visit adds a snapshot — the chart fills in over the next few days."
            : `${daysCollected} day collected. ${
                daysCollected === 1 ? "One more" : `${2 - daysCollected} more`
              } needed before the line renders.`}
        </p>
        <p className="text-[10px] font-mono text-muted-foreground/60 inline-flex items-center gap-1">
          <Info className="h-3 w-3" />
          No public Zcash node exposes historical shielded supply.
        </p>
      </div>
    )
  }
  return (
    <div className="h-48 md:h-64">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={points}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
          stackOffset="none"
        >
          <defs>
            <linearGradient id="shielded-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SHIELD_COLOR} stopOpacity={0.5} />
              <stop offset="100%" stopColor={SHIELD_COLOR} stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="transparent-fill" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={TRANSPARENT_COLOR}
                stopOpacity={0.4}
              />
              <stop
                offset="100%"
                stopColor={TRANSPARENT_COLOR}
                stopOpacity={0.05}
              />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#1f2937" strokeDasharray="2 4" />
          <XAxis
            dataKey="label"
            tick={{ fill: "#64748b", fontSize: 10 }}
            stroke="#1f2937"
            interval="preserveStartEnd"
            minTickGap={32}
          />
          <YAxis
            tick={{ fill: "#64748b", fontSize: 10 }}
            stroke="#1f2937"
            tickFormatter={(v: number) => fmtZecShort(v)}
            width={56}
            domain={["auto", "auto"]}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#0b0f14e6",
              border: "1px solid #1f2937",
              borderRadius: 8,
              fontFamily: "monospace",
              fontSize: 11,
            }}
            labelStyle={{ color: "#9ca3af" }}
            formatter={(v: number, name: string) => {
              if (name === "shielded")
                return [`${fmtZecShort(v)} ZEC`, "Shielded"]
              if (name === "transparent")
                return [`${fmtZecShort(v)} ZEC`, "Transparent"]
              return [v, name]
            }}
          />
          <Area
            type="monotone"
            dataKey="transparent"
            stackId="supply"
            stroke={TRANSPARENT_COLOR}
            strokeWidth={1.5}
            fill="url(#transparent-fill)"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="shielded"
            stackId="supply"
            stroke={SHIELD_COLOR}
            strokeWidth={2}
            fill="url(#shielded-fill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
