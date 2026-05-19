"use client"

import useSWR from "swr"
import { useMemo } from "react"
import { usePersistentState } from "@/lib/use-persistent-state"
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Bar,
  BarChart,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts"
import { TrendingUp, ShieldCheck, ArrowRightLeft } from "lucide-react"

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

type SupplyChartTab = "mcap" | "shielded" | "tx"
const isSupplyChartTab = (v: unknown): v is SupplyChartTab =>
  v === "mcap" || v === "shielded" || v === "tx"

interface TxDay {
  date: string
  total: number
  transparentOnly: number
  shielding: number
  deshielding: number
  fullyShielded: number
  mixed: number
}
interface TxStatsResponse {
  days: TxDay[]
  fetchedAt: number
  stale?: boolean
}

export function SupplyCharts({
  mcapSeries,
}: {
  mcapSeries: [number, number][] | null | undefined
}) {
  const [tab, setTab] = usePersistentState<SupplyChartTab>(
    "cyphzec.stats.supplyChartTab",
    "mcap",
    isSupplyChartTab
  )
  // Same window selector serves both the Shielded and Transactions
  // tabs — they share a similar "deep history, want to zoom" shape.
  // Renamed key would orphan existing users so we keep the old
  // localStorage key for backward compatibility.
  const [historyWindow, setHistoryWindow] =
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
  // Tx-stats has the same regen cadence as the shielded history (both
  // daily), so we reuse the 30 min refresh interval. SWR + keepPrev
  // means switching to the Tx tab cold doesn't blink.
  const { data: txStats } = useSWR<TxStatsResponse>(
    "/api/zec-tx-stats",
    fetcher,
    {
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
    const window = SHIELDED_WINDOWS.find((w) => w.id === historyWindow)
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
  }, [history?.points, historyWindow])

  // Tx points get the same window-slice treatment as shielded, then
  // collapse the 4 shielded-touching buckets (shielding, deshielding,
  // fully-shielded, mixed) into one "shielded-touching" line. Two
  // categories total — "transparent only" vs. "shielded" — keep the
  // chart legible on phones; the tooltip still surfaces the per-
  // bucket breakdown for users who want it.
  const txPoints = useMemo(() => {
    const days = txStats?.days ?? []
    const window = SHIELDED_WINDOWS.find((w) => w.id === historyWindow)
    const sliced =
      window?.days != null && days.length > window.days
        ? days.slice(-window.days)
        : days
    return sliced.map((d) => {
      const shieldedTouching =
        d.shielding + d.deshielding + d.fullyShielded + d.mixed
      return {
        label: fmtDate(d.date),
        date: d.date,
        transparentOnly: d.transparentOnly,
        shielded: shieldedTouching,
        // Carry the breakdown through so the tooltip can show it.
        shielding: d.shielding,
        deshielding: d.deshielding,
        fullyShielded: d.fullyShielded,
        mixed: d.mixed,
        total: d.total,
      }
    })
  }, [txStats?.days, historyWindow])

  // The window selector is meaningful for the Shielded + Transactions
  // tabs (both have years of history); Mcap is fixed at 30D so we
  // hide it there.
  const showWindowSelector = tab === "shielded" || tab === "tx"

  return (
    <section className="rounded-lg border border-border bg-card flex flex-col">
      {/* Tab bar — labels stay short so the row keeps fitting on
          phones once the window selector appears on the right for the
          history tabs. */}
      <div className="flex items-center gap-0 border-b border-border overflow-x-auto">
        <ChartTab
          active={tab === "mcap"}
          onClick={() => setTab("mcap")}
          icon={<TrendingUp className="size-3.5" />}
          label="Market cap"
        />
        <ChartTab
          active={tab === "shielded"}
          onClick={() => setTab("shielded")}
          icon={<ShieldCheck className="size-3.5" />}
          label="Shielded"
        />
        <ChartTab
          active={tab === "tx"}
          onClick={() => setTab("tx")}
          icon={<ArrowRightLeft className="size-3.5" />}
          label="Transactions"
        />

        {showWindowSelector && (
          <div className="ml-auto pr-2 flex items-center gap-0.5 text-[10px] font-mono shrink-0">
            {SHIELDED_WINDOWS.map((w) => (
              <button
                key={w.id}
                onClick={() => setHistoryWindow(w.id)}
                className={`px-1.5 py-1 rounded transition-colors ${
                  historyWindow === w.id
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
        {tab === "mcap" && <McapChart points={mcapPoints} />}
        {tab === "shielded" && (
          <ShieldedChart
            points={shieldedPoints}
            daysCollected={history?.daysCollected ?? 0}
          />
        )}
        {tab === "tx" && <TxChart points={txPoints} />}
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
        <ShieldCheck className="size-6 text-emerald-400/70" />
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
        className="inline-block size-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  )
}

// ─── Transactions chart ───────────────────────────────────────────────────────

interface TxPoint {
  label: string
  date: string
  transparentOnly: number
  shielded: number
  shielding: number
  deshielding: number
  fullyShielded: number
  mixed: number
  total: number
}

const TX_TRANSPARENT_COLOR = "#94a3b8" // slate-400 — neutral, dim
const TX_SHIELDED_COLOR = "#34d399" // emerald-400 — privacy = positive

function fmtTxAxis(v: number) {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(0)}K`
  return v.toFixed(0)
}

function TxChart({ points }: { points: TxPoint[] }) {
  if (points.length === 0) {
    return (
      <div className="h-48 md:h-64 flex items-center justify-center text-xs font-mono text-muted-foreground">
        No tx data available yet.
      </div>
    )
  }
  // Compute the rolling share of shielded-touching txs in the visible
  // window — useful one-glance metric: "are people using shielded at
  // all right now?". Lives in the chart header above the bars.
  const totals = points.reduce(
    (acc, p) => {
      acc.transparent += p.transparentOnly
      acc.shielded += p.shielded
      return acc
    },
    { transparent: 0, shielded: 0 }
  )
  const totalTxs = totals.transparent + totals.shielded
  const shieldedPct =
    totalTxs > 0 ? (totals.shielded / totalTxs) * 100 : null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-[10px] font-mono">
        <div className="flex items-center gap-3 text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-2 rounded-sm"
              style={{ backgroundColor: TX_SHIELDED_COLOR }}
            />
            Shielded
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-2 rounded-sm"
              style={{ backgroundColor: TX_TRANSPARENT_COLOR }}
            />
            Transparent
          </span>
        </div>
        {shieldedPct != null && (
          <span className="text-foreground/80">
            <span style={{ color: TX_SHIELDED_COLOR }}>
              {shieldedPct.toFixed(1)}%
            </span>
            <span className="text-muted-foreground"> shielded in window</span>
          </span>
        )}
      </div>
      <div className="h-48 md:h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={points}
            margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(255,255,255,0.05)"
              vertical={false}
            />
            <XAxis
              dataKey="label"
              tick={{
                fill: "#64748b",
                fontSize: 10,
                fontFamily: "monospace",
              }}
              axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={32}
            />
            <YAxis
              tick={{
                fill: "#64748b",
                fontSize: 10,
                fontFamily: "monospace",
              }}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmtTxAxis}
              width={44}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null
                const p = payload[0].payload as TxPoint
                // Per-bucket breakdown comes through to the tooltip so
                // power users can see the shielding-vs-deshielding-vs-
                // fully-shielded split without us cluttering the chart
                // itself.
                return (
                  <div className="rounded-lg border border-border bg-card/95 backdrop-blur-sm p-2 shadow-xl text-[11px] font-mono min-w-[14rem]">
                    <p className="text-muted-foreground mb-1">
                      {String(label)}
                    </p>
                    <div className="flex justify-between gap-4">
                      <span style={{ color: TX_SHIELDED_COLOR }}>
                        Shielded
                      </span>
                      <span className="text-foreground font-semibold">
                        {p.shielded.toLocaleString("en-US")}
                      </span>
                    </div>
                    <div className="flex justify-between gap-4 pl-2 text-muted-foreground">
                      <span>fully shielded</span>
                      <span>{p.fullyShielded.toLocaleString("en-US")}</span>
                    </div>
                    <div className="flex justify-between gap-4 pl-2 text-muted-foreground">
                      <span>shielding (T → Z)</span>
                      <span>{p.shielding.toLocaleString("en-US")}</span>
                    </div>
                    <div className="flex justify-between gap-4 pl-2 text-muted-foreground">
                      <span>deshielding (Z → T)</span>
                      <span>{p.deshielding.toLocaleString("en-US")}</span>
                    </div>
                    <div className="flex justify-between gap-4 pl-2 text-muted-foreground">
                      <span>mixed</span>
                      <span>{p.mixed.toLocaleString("en-US")}</span>
                    </div>
                    <div className="flex justify-between gap-4 mt-1">
                      <span style={{ color: TX_TRANSPARENT_COLOR }}>
                        Transparent only
                      </span>
                      <span className="text-foreground font-semibold">
                        {p.transparentOnly.toLocaleString("en-US")}
                      </span>
                    </div>
                    <div className="flex justify-between gap-4 mt-1 pt-1 border-t border-border/40">
                      <span className="text-muted-foreground">Total</span>
                      <span className="text-foreground font-semibold">
                        {p.total.toLocaleString("en-US")}
                      </span>
                    </div>
                  </div>
                )
              }}
            />
            {/* Stacked bars: transparent on bottom (anchored, neutral
                color) with shielded stacked on top in the brand green.
                Same stackId joins them; isAnimationActive=false matches
                the other charts and avoids the post-tab-switch wobble. */}
            <Bar
              dataKey="transparentOnly"
              stackId="tx"
              fill={TX_TRANSPARENT_COLOR}
              isAnimationActive={false}
            />
            <Bar
              dataKey="shielded"
              stackId="tx"
              fill={TX_SHIELDED_COLOR}
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[10px] font-mono text-muted-foreground/60 leading-relaxed">
        Daily on-chain tx counts via{" "}
        <a
          href="https://zecstats.com"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground underline-offset-2 hover:underline"
        >
          zecstats.com
        </a>
        . &ldquo;Shielded&rdquo; sums shielding, deshielding, fully-shielded,
        and mixed txs.
      </p>
    </div>
  )
}
