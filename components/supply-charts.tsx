"use client"

import useSWR from "swr"
import { useMemo } from "react"
import { usePersistentState } from "@/lib/use-persistent-state"
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts"
import { TrendingUp, ShieldCheck } from "lucide-react"

const ZEC_COLOR = "#fb923c"

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

type ShieldedWindow = "1y" | "3y" | "all"
const SHIELDED_WINDOWS: { id: ShieldedWindow; label: string; days: number | null }[] = [
  { id: "1y", label: "1Y", days: 365 },
  { id: "3y", label: "3Y", days: 365 * 3 },
  { id: "all", label: "All", days: null },
]

export function SupplyCharts({
  mcapSeries,
}: {
  mcapSeries: [number, number][] | null | undefined
}) {
  const [tab, setTab] = usePersistentState<"mcap" | "shielded">(
    "cyphzec.stats.supplyChartTab",
    "mcap",
    (v): v is "mcap" | "shielded" => v === "mcap" || v === "shielded"
  )
  const [shieldedWindow, setShieldedWindow] =
    usePersistentState<ShieldedWindow>(
      "cyphzec.stats.shieldedWindow",
      "1y",
      (v): v is ShieldedWindow => v === "1y" || v === "3y" || v === "all"
    )

  const { data: history } = useSWR<ShieldedHistoryResponse>(
    "/api/zec-stats/history",
    fetcher,
    {
      // History is daily-resolution and the upstream regenerates ~once
      // per day. Cheap revalidate every 30 min keeps the chart fresh
      // without hammering KV on every tab switch.
      refreshInterval: 30 * 60_000,
      keepPreviousData: true,
    }
  )

  const mcapPoints = (mcapSeries ?? []).map(([ts, mcap]) => ({
    ts,
    label: fmtUnixDate(ts),
    mcap,
  }))

  const shieldedPoints = useMemo(() => {
    const points = history?.points ?? []
    const window = SHIELDED_WINDOWS.find((w) => w.id === shieldedWindow)
    const sliced =
      window?.days != null && points.length > window.days
        ? points.slice(-window.days)
        : points
    return sliced.map((p) => ({
      label: fmtDate(p.date),
      shielded: p.total,
      sapling: p.sapling ?? 0,
      orchard: p.orchard ?? 0,
      sprout: p.sprout ?? 0,
    }))
  }, [history?.points, shieldedWindow])

  return (
    <section className="rounded-lg border border-border bg-card flex flex-col">
      {/* Tab bar — labels stay short ("Market cap" / "Shielded") so
          the row keeps fitting on phones once the window selector
          appears on the right for the shielded tab. */}
      <div className="flex items-center gap-0 border-b border-border">
        <ChartTab
          active={tab === "mcap"}
          onClick={() => setTab("mcap")}
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          label="Market cap"
        />
        <ChartTab
          active={tab === "shielded"}
          onClick={() => setTab("shielded")}
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
          label="Shielded"
        />

        {/* Window selector — only meaningful for the shielded tab,
            which has ~10y of history. The mcap tab is fixed at 30D so
            we hide the window selector when it's active. */}
        {tab === "shielded" && (
          <div className="ml-auto pr-2 flex items-center gap-0.5 text-[10px] font-mono shrink-0">
            {SHIELDED_WINDOWS.map((w) => (
              <button
                key={w.id}
                onClick={() => setShieldedWindow(w.id)}
                className={`px-1.5 py-1 rounded transition-colors ${
                  shieldedWindow === w.id
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        )}
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
      className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-mono font-semibold border-b-2 transition-colors whitespace-nowrap shrink-0 ${
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

// Per-pool palette — distinct hues so the stacked layers don't blur
// into each other on a 200px-tall mobile chart.
const ORCHARD_COLOR = "#34d399" // emerald — newest + dominant pool today
const SAPLING_COLOR = "#6ee7b7" // mint — dominant 2018 → ~2023
const SPROUT_COLOR = "#a7f3d0" // pale mint — legacy original pool

function ShieldedChart({
  points,
  daysCollected,
}: {
  points: {
    label: string
    shielded: number
    sapling: number
    orchard: number
    sprout: number
  }[]
  daysCollected: number
}) {
  // No data — likely the upstream zecprice fetch failed and there's
  // nothing in KV either. Surface a quiet placeholder instead of an
  // empty chart frame.
  if (daysCollected < 2 || points.length < 2) {
    return (
      <div className="h-48 md:h-64 flex flex-col items-center justify-center gap-2 text-center px-4">
        <ShieldCheck className="h-6 w-6 text-emerald-400/70" />
        <p className="text-xs font-mono text-foreground">
          Shielded history unavailable
        </p>
        <p className="text-[11px] font-mono text-muted-foreground/70 max-w-sm leading-relaxed">
          The historical feed didn&rsquo;t respond just now — try again
          in a few minutes.
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
            <linearGradient id="orchard-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ORCHARD_COLOR} stopOpacity={0.55} />
              <stop offset="100%" stopColor={ORCHARD_COLOR} stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="sapling-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SAPLING_COLOR} stopOpacity={0.45} />
              <stop offset="100%" stopColor={SAPLING_COLOR} stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="sprout-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SPROUT_COLOR} stopOpacity={0.35} />
              <stop offset="100%" stopColor={SPROUT_COLOR} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#1f2937" strokeDasharray="2 4" />
          <XAxis
            dataKey="label"
            tick={{ fill: "#64748b", fontSize: 10 }}
            stroke="#1f2937"
            interval="preserveStartEnd"
            minTickGap={48}
          />
          <YAxis
            tick={{ fill: "#64748b", fontSize: 10 }}
            stroke="#1f2937"
            tickFormatter={(v: number) => fmtZecShort(v)}
            width={56}
            domain={[0, "auto"]}
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
              const labels: Record<string, string> = {
                sprout: "Sprout",
                sapling: "Sapling",
                orchard: "Orchard",
              }
              return [`${fmtZecShort(v)} ZEC`, labels[name] ?? name]
            }}
          />
          {/* Stack order from bottom up: sprout (oldest) → sapling
              → orchard (newest, dominant). The visual reads as a
              telescoping migration from one pool to the next. */}
          <Area
            type="monotone"
            dataKey="sprout"
            stackId="pool"
            stroke={SPROUT_COLOR}
            strokeWidth={1}
            fill="url(#sprout-fill)"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="sapling"
            stackId="pool"
            stroke={SAPLING_COLOR}
            strokeWidth={1.25}
            fill="url(#sapling-fill)"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="orchard"
            stackId="pool"
            stroke={ORCHARD_COLOR}
            strokeWidth={2}
            fill="url(#orchard-fill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
      {/* Small inline legend; spelled out at this size so users don't
          have to hover to map color → pool. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-2 text-[10px] font-mono text-muted-foreground">
        <PoolDot color={ORCHARD_COLOR} label="Orchard" />
        <PoolDot color={SAPLING_COLOR} label="Sapling" />
        <PoolDot color={SPROUT_COLOR} label="Sprout" />
      </div>
    </div>
  )
}

function PoolDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  )
}
