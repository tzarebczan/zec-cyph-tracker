"use client"

import { useMemo } from "react"
import useSWR from "swr"
import {
  ResponsiveContainer,
  AreaChart,
  ComposedChart,
  Area,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts"

// Per-day metrics replayed off the same data sources the rest of /holdings
// uses, so we don't need a new API surface. CYPH historical price (~6m
// since treasury start) + ZEC historical price both come from /api/prices,
// the buy/sell list comes from /api/cypherpunk-holdings, and the current
// snapshots (shares outstanding, ZEC circulating supply) come from
// /api/quote + /api/zec-stats. We replay every chart from a single
// useTreasuryHistory() pass so all metrics share the same date axis.
//
// IMPORTANT CAVEATS, surfaced as a small footnote on the page so users
// don't think we're hiding the math:
//
//   1. Yahoo only exposes shares outstanding as a current snapshot
//      (sourced from the latest 10-Q / 10-K, lagged by weeks). For a
//      ~6-month window the dilution is usually modest, but when CYPH
//      raises capital the navPerShare / mNAV / ZEC-per-share lines
//      temporarily under-estimate "per share" until the next filing
//      lands. We label the affected charts as "current shares applied
//      to history" so the assumption is visible.
//
//   2. CoinGecko's free /coins/zcash/market_chart endpoint we use for
//      ZEC market cap only goes back ~30 days, so for older dates the
//      mcap-ratio chart and "% of ZEC supply" chart approximate ZEC
//      mcap as `historicalPrice × currentSupply`. ZEC supply grows
//      ~5%/yr, so the older end of the chart slightly under-counts
//      circulating supply. The trend/shape is preserved.

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const json = await res.json()
  if (!res.ok || (json && typeof json === "object" && "error" in json)) {
    throw new Error(json?.error ?? `Request failed: ${res.status}`)
  }
  return json
}

interface HistoryPoint {
  timestamp: number
  date: string
  cyph: number
  zec: number
  ratio: number | null
}
interface PricesResponse {
  history: HistoryPoint[]
}
interface Tx {
  date: string
  type: "buy" | "sell"
  assetSymbol: string
  amount: number | null
  totalValue: number | null
}
interface HoldingsResponse {
  transactions: Tx[]
}
interface QuoteResponse {
  sharesOutstanding: number | null
}
interface ZecStatsResponse {
  circulating: number | null
  mcapSeries?: [number, number][]
}

interface TreasuryDay {
  ts: number
  /** Pre-formatted "MMM D" label for the X axis. Stable across locales. */
  date: string
  cyph: number
  zec: number
  /** Cumulative ZEC held by the treasury as of this date (sum of buys
   *  minus sells dated on or before `ts`). */
  treasuryZec: number
  /** Cumulative USD spent acquiring the treasury as of this date. */
  cumCostUSD: number
  /** Treasury value in USD = treasuryZec × zec. */
  navUSD: number | null
  /** Per-share NAV using current shares outstanding (see caveat #1). */
  navPerShare: number | null
  /** mNAV = cyphPrice / navPerShare. <1 = discount, >1 = premium. */
  mNav: number | null
  /** Premium/discount as a % delta from NAV per share. */
  premiumPct: number | null
  /** ZEC backing per CYPH share. Monotonically grows as the treasury
   *  accumulates (modulo dilution, which we can't see day-by-day). */
  zecPerShare: number | null
  /** Treasury size as a % of ZEC's circulating supply that day. */
  pctOfSupply: number | null
  /** Hypothetical ZEC spot price that would push mNAV to 1.0 — i.e.
   *  the ZEC price the market is implicitly pricing into CYPH. */
  impliedZec: number | null
  /** Volume-weighted USD/ZEC paid up to this date. */
  avgCostPerZec: number | null
  /** CYPH market cap × current shares (constant, see caveat #1). */
  cyphMcap: number | null
  /** ZEC market cap from CG history when available, falls back to
   *  zec × currentSupply (see caveat #2). */
  zecMcap: number | null
  /** Bps ratio of CYPH mcap to ZEC mcap. 100 = 1%, 1000 = 10%. */
  mcapRatioBps: number | null
}

interface VelocityWeek {
  /** Unix-ms of the week's Monday 00:00 UTC. */
  ts: number
  date: string
  /** Net ZEC added that week (buys minus sells). */
  net: number
  /** Cumulative ZEC after this week's transactions. */
  cumulative: number
}

const CYPH_COLOR = "#34d399"
const ZEC_COLOR = "#fb923c"
const SKY = "#38bdf8"
const GREEN = "#22c55e"
const RED = "#ef4444"
const MUTED_GRID = "rgba(255,255,255,0.05)"
const MUTED_AXIS = "rgba(255,255,255,0.08)"
const TICK_FILL = "#64748b"

/** Compute mNAV's "1.0" reference, the ZEC-per-share floor, and so on
 *  for every day we have CYPH price data. Memoized off the four
 *  upstream fetches, so flipping tabs / re-renders don't recompute. */
function useTreasuryHistory(): {
  series: TreasuryDay[]
  velocity: VelocityWeek[]
  shares: number | null
  hasShares: boolean
  loading: boolean
} {
  const { data: prices, isLoading: pricesLoading } = useSWR<PricesResponse>(
    "/api/prices?days=all",
    fetcher,
    { refreshInterval: 60_000, keepPreviousData: true }
  )
  const { data: holdings, isLoading: holdingsLoading } =
    useSWR<HoldingsResponse>("/api/cypherpunk-holdings", fetcher, {
      refreshInterval: 60 * 60_000,
      keepPreviousData: true,
    })
  const { data: quote } = useSWR<QuoteResponse>("/api/quote", fetcher, {
    refreshInterval: 30_000,
    keepPreviousData: true,
  })
  const { data: zecStats } = useSWR<ZecStatsResponse>(
    "/api/zec-stats",
    fetcher,
    { refreshInterval: 5 * 60_000, keepPreviousData: true }
  )

  return useMemo(() => {
    const empty = {
      series: [] as TreasuryDay[],
      velocity: [] as VelocityWeek[],
      shares: quote?.sharesOutstanding ?? null,
      hasShares: false,
      loading: pricesLoading || holdingsLoading,
    }
    const history = prices?.history
    const txsRaw = holdings?.transactions
    if (!history || history.length === 0 || !txsRaw) return empty

    // Normalize buys/sells into chronological signed-amount events.
    // Filter to ZEC because the treasury endpoint also surfaces non-ZEC
    // historic txs we don't track here.
    const txs = txsRaw
      .filter((t) => t.assetSymbol === "ZEC")
      .map((t) => ({
        ts: new Date(t.date).getTime(),
        amount: (t.type === "buy" ? 1 : -1) * (t.amount ?? 0),
        cost: (t.type === "buy" ? 1 : -1) * (t.totalValue ?? 0),
      }))
      .filter((t) => Number.isFinite(t.ts))
      .sort((a, b) => a.ts - b.ts)

    const shares = quote?.sharesOutstanding ?? null
    const hasShares = shares != null && shares > 0
    const currentZecSupply = zecStats?.circulating ?? null

    // ZEC mcap by ISO date when CG history is available — keys are the
    // upstream UTC midnight; we line them up to history points by date
    // string (which the prices API has already normalized to "MMM D" /
    // ISO-ish format depending on the route's formatter).
    const zecMcapByDate = new Map<string, number>()
    for (const [ts, mcap] of zecStats?.mcapSeries ?? []) {
      const iso = new Date(ts).toISOString().slice(0, 10)
      zecMcapByDate.set(iso, mcap)
    }

    // Two-pointer walk: history is daily ascending, txs are
    // ascending — so accumulating treasuryZec as we advance is O(N+M).
    let txIdx = 0
    let treasuryZec = 0
    let cumCostUSD = 0
    const series: TreasuryDay[] = history.map((p) => {
      while (txIdx < txs.length && txs[txIdx].ts <= p.timestamp) {
        treasuryZec += txs[txIdx].amount
        cumCostUSD += txs[txIdx].cost
        txIdx++
      }

      const navUSD = treasuryZec > 0 ? treasuryZec * p.zec : null
      const navPerShare =
        hasShares && navUSD != null ? navUSD / (shares as number) : null
      const mNav =
        navPerShare != null && navPerShare > 0 ? p.cyph / navPerShare : null
      const premiumPct =
        navPerShare != null && navPerShare > 0
          ? ((p.cyph - navPerShare) / navPerShare) * 100
          : null
      const zecPerShare =
        hasShares && treasuryZec > 0 ? treasuryZec / (shares as number) : null
      const impliedZec =
        hasShares && treasuryZec > 0
          ? (p.cyph * (shares as number)) / treasuryZec
          : null
      const avgCostPerZec =
        treasuryZec > 0 ? cumCostUSD / treasuryZec : null
      const cyphMcap = hasShares ? p.cyph * (shares as number) : null

      // Prefer CG's daily mcap series; older dates that fall outside its
      // 30d window approximate via current circulating supply. ZEC
      // emission grows ~5%/yr, so this is a small under-count at the
      // historical end but the trend is right.
      const isoKey = new Date(p.timestamp).toISOString().slice(0, 10)
      const zecMcap =
        zecMcapByDate.get(isoKey) ??
        (currentZecSupply != null ? p.zec * currentZecSupply : null)

      const mcapRatioBps =
        cyphMcap != null && zecMcap != null && zecMcap > 0
          ? (cyphMcap / zecMcap) * 10_000
          : null

      // % of supply uses the same fallback chain as zecMcap. We back
      // out the supply on each day from mcap/price when we have mcap,
      // otherwise use today's circulating.
      const supplyAtDate =
        zecMcapByDate.has(isoKey) && p.zec > 0
          ? (zecMcapByDate.get(isoKey) as number) / p.zec
          : currentZecSupply ?? null
      const pctOfSupply =
        supplyAtDate != null && supplyAtDate > 0 && treasuryZec > 0
          ? (treasuryZec / supplyAtDate) * 100
          : null

      return {
        ts: p.timestamp,
        date: p.date,
        cyph: p.cyph,
        zec: p.zec,
        treasuryZec,
        cumCostUSD,
        navUSD,
        navPerShare,
        mNav,
        premiumPct,
        zecPerShare,
        pctOfSupply,
        impliedZec,
        avgCostPerZec,
        cyphMcap,
        zecMcap,
        mcapRatioBps,
      }
    })

    // Weekly acquisition bars. We bucket by ISO week (Monday-anchored
    // UTC). Cumulative is the running total *after* the bucket so the
    // line aligns with the right-hand edge of each bar.
    const buckets = new Map<number, VelocityWeek>()
    let cumulative = 0
    const sortedTxs = [...txs].sort((a, b) => a.ts - b.ts)
    for (const tx of sortedTxs) {
      cumulative += tx.amount
      const d = new Date(tx.ts)
      // Snap to UTC Monday 00:00. JavaScript getDay returns 0 (Sun)
      // through 6 (Sat); shift so Monday=0 / Sunday=6 then subtract.
      const weekday = (d.getUTCDay() + 6) % 7
      const monday = new Date(
        Date.UTC(
          d.getUTCFullYear(),
          d.getUTCMonth(),
          d.getUTCDate() - weekday
        )
      )
      const weekTs = monday.getTime()
      const existing = buckets.get(weekTs)
      const dateLabel = monday.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
      if (existing) {
        existing.net += tx.amount
        existing.cumulative = cumulative
      } else {
        buckets.set(weekTs, {
          ts: weekTs,
          date: dateLabel,
          net: tx.amount,
          cumulative,
        })
      }
    }
    const velocity = Array.from(buckets.values()).sort((a, b) => a.ts - b.ts)

    return {
      series,
      velocity,
      shares,
      hasShares,
      loading: false,
    }
  }, [prices, holdings, quote, zecStats, pricesLoading, holdingsLoading])
}

// ─── shared chart shell ──────────────────────────────────────────────────────

/** A consistent header + chart frame so the seven charts read as a set
 *  rather than seven different mini-experiments. The right-hand
 *  meta slot is for the current value or any other one-line context. */
function ChartCard({
  title,
  subtitle,
  meta,
  children,
}: {
  title: string
  subtitle?: string
  meta?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border border-border bg-card flex flex-col">
      <header className="flex items-start justify-between gap-2 px-3 md:px-4 pt-3 pb-2 border-b border-border/40">
        <div className="flex flex-col min-w-0">
          <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            {title}
          </h3>
          {subtitle && (
            <p className="text-[10px] font-mono text-muted-foreground/70 leading-snug mt-0.5">
              {subtitle}
            </p>
          )}
        </div>
        {meta && (
          <div className="text-[10px] font-mono text-muted-foreground text-right shrink-0 leading-snug">
            {meta}
          </div>
        )}
      </header>
      <div className="h-44 md:h-52 px-1 md:px-2 py-2">{children}</div>
    </section>
  )
}

/** Section header — one per group of related charts. Lighter weight
 *  than ChartCard's title so it reads as a parent grouping. */
function SectionHeader({
  label,
  hint,
}: {
  label: string
  hint?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 pt-2">
      <h2 className="text-[11px] font-mono uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </h2>
      {hint && (
        <span className="text-[10px] font-mono text-muted-foreground/60 truncate">
          {hint}
        </span>
      )}
    </div>
  )
}

// ─── tooltip helpers ─────────────────────────────────────────────────────────

const fmtUsd = (n: number, dp = 2) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
const fmtPct = (n: number, dp = 2) =>
  `${n >= 0 ? "+" : ""}${n.toFixed(dp)}%`
const fmtCount = (n: number, dp = 0) =>
  n.toLocaleString("en-US", { maximumFractionDigits: dp })
const fmtBps = (n: number) => `${(n / 100).toFixed(2)}%` // bps → percent

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TooltipShell({ label, rows }: { label: string; rows: { color: string; name: string; value: string }[] }) {
  return (
    <div className="rounded-lg border border-border bg-card/95 backdrop-blur-sm p-2 shadow-xl text-[11px] font-mono min-w-[12rem]">
      <p className="text-muted-foreground mb-1">{label}</p>
      {rows.map((r) => (
        <div key={r.name} className="flex justify-between gap-4">
          <span style={{ color: r.color }}>{r.name}</span>
          <span className="text-foreground font-semibold">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

// ─── individual charts ───────────────────────────────────────────────────────

function MNavChart({ data }: { data: TreasuryDay[] }) {
  const points = data.filter((d) => d.premiumPct != null)
  const last = points[points.length - 1]
  return (
    <ChartCard
      title="mNAV premium / discount"
      subtitle="(CYPH − NAV) ÷ NAV per share, per day. Zero = trading at NAV."
      meta={
        last?.premiumPct != null && (
          <span className={last.premiumPct >= 0 ? "text-green-400" : "text-red-400"}>
            {fmtPct(last.premiumPct, 1)}
          </span>
        )
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <defs>
            {/* Single gradient that's green at the top, fades through
                neutral at zero, and red at the bottom — gives the
                diverging-fill effect without needing two overlapping
                Areas (which produced sawtooth strokes at zero crossings).
                The stops are tuned so the fade lives roughly around the
                middle of the chart's value range. */}
            <linearGradient id="mnav-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={GREEN} stopOpacity={0.35} />
              <stop offset="48%" stopColor={GREEN} stopOpacity={0.04} />
              <stop offset="52%" stopColor={RED} stopOpacity={0.04} />
              <stop offset="100%" stopColor={RED} stopOpacity={0.35} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={MUTED_GRID} vertical={false} />
          <XAxis dataKey="date" tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }} axisLine={{ stroke: MUTED_AXIS }} tickLine={false} interval="preserveStartEnd" minTickGap={32} />
          <YAxis
            tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`}
            width={44}
          />
          <ReferenceLine
            y={0}
            stroke={TICK_FILL}
            strokeOpacity={0.6}
            strokeDasharray="3 3"
            label={{ value: "NAV", position: "insideRight", fill: TICK_FILL, fontSize: 9, fontFamily: "monospace", offset: 6 }}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as TreasuryDay
              return (
                <TooltipShell
                  label={String(label)}
                  rows={[
                    { color: SKY, name: "mNAV", value: p.mNav != null ? `${p.mNav.toFixed(2)}×` : "—" },
                    { color: p.premiumPct != null && p.premiumPct >= 0 ? GREEN : RED, name: "Premium", value: p.premiumPct != null ? fmtPct(p.premiumPct, 1) : "—" },
                    { color: TICK_FILL, name: "$CYPH", value: fmtUsd(p.cyph, 2) },
                    { color: TICK_FILL, name: "NAV/sh", value: p.navPerShare != null ? fmtUsd(p.navPerShare, 2) : "—" },
                  ]}
                />
              )
            }}
          />
          <Area
            type="monotone"
            dataKey="premiumPct"
            stroke={SKY}
            strokeWidth={2}
            fill="url(#mnav-fill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function McapRatioChart({ data }: { data: TreasuryDay[] }) {
  const points = data.filter((d) => d.mcapRatioBps != null)
  const last = points[points.length - 1]
  return (
    <ChartCard
      title="CYPH ÷ ZEC market cap"
      subtitle="CYPH market cap as a fraction of ZEC's. Same unit, different question than the price ratio."
      meta={
        last?.mcapRatioBps != null && (
          <span className="text-foreground/80">{fmtBps(last.mcapRatioBps)}</span>
        )
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="mcap-ratio" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SKY} stopOpacity={0.4} />
              <stop offset="100%" stopColor={SKY} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={MUTED_GRID} vertical={false} />
          <XAxis dataKey="date" tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }} axisLine={{ stroke: MUTED_AXIS }} tickLine={false} interval="preserveStartEnd" minTickGap={32} />
          <YAxis tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${(v / 100).toFixed(1)}%`} width={44} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as TreasuryDay
              return (
                <TooltipShell
                  label={String(label)}
                  rows={[
                    { color: SKY, name: "CYPH/ZEC mcap", value: p.mcapRatioBps != null ? fmtBps(p.mcapRatioBps) : "—" },
                    { color: CYPH_COLOR, name: "CYPH mcap", value: p.cyphMcap != null ? `$${(p.cyphMcap / 1e6).toFixed(1)}M` : "—" },
                    { color: ZEC_COLOR, name: "ZEC mcap", value: p.zecMcap != null ? `$${(p.zecMcap / 1e9).toFixed(2)}B` : "—" },
                  ]}
                />
              )
            }}
          />
          <Area type="monotone" dataKey="mcapRatioBps" stroke={SKY} strokeWidth={2} fill="url(#mcap-ratio)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function ImpliedZecChart({ data }: { data: TreasuryDay[] }) {
  const points = data.filter((d) => d.impliedZec != null && d.zec > 0)
  const last = points[points.length - 1]
  const subtitle =
    "ZEC spot price vs. the price the CYPH share is implicitly pricing in (mNAV → 1)."
  return (
    <ChartCard
      title="Market-implied ZEC price"
      subtitle={subtitle}
      meta={
        last && (
          <span className="flex flex-col items-end leading-tight">
            <span className="text-foreground/80">implied {fmtUsd((last.impliedZec ?? 0), 0)}</span>
            <span className="text-muted-foreground">spot {fmtUsd(last.zec, 0)}</span>
          </span>
        )
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={MUTED_GRID} vertical={false} />
          <XAxis dataKey="date" tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }} axisLine={{ stroke: MUTED_AXIS }} tickLine={false} interval="preserveStartEnd" minTickGap={32} />
          <YAxis tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `$${v.toFixed(0)}`} width={48} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as TreasuryDay
              return (
                <TooltipShell
                  label={String(label)}
                  rows={[
                    { color: SKY, name: "Implied ZEC", value: p.impliedZec != null ? fmtUsd(p.impliedZec, 0) : "—" },
                    { color: ZEC_COLOR, name: "Spot ZEC", value: fmtUsd(p.zec, 0) },
                    { color: TICK_FILL, name: "Spread", value: p.impliedZec != null ? fmtUsd(p.impliedZec - p.zec, 0) : "—" },
                  ]}
                />
              )
            }}
          />
          <Line type="monotone" dataKey="zec" stroke={ZEC_COLOR} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="impliedZec" stroke={SKY} strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function ZecPerShareChart({ data }: { data: TreasuryDay[] }) {
  const points = data.filter((d) => d.zecPerShare != null)
  const last = points[points.length - 1]
  return (
    <ChartCard
      title="ZEC per CYPH share"
      subtitle="Treasury ZEC ÷ shares outstanding. Each share's claim on the underlying."
      meta={
        last?.zecPerShare != null && (
          <span className="text-foreground/80">
            {last.zecPerShare.toFixed(4)} ZEC
          </span>
        )
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="zps" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ZEC_COLOR} stopOpacity={0.4} />
              <stop offset="100%" stopColor={ZEC_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={MUTED_GRID} vertical={false} />
          <XAxis dataKey="date" tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }} axisLine={{ stroke: MUTED_AXIS }} tickLine={false} interval="preserveStartEnd" minTickGap={32} />
          <YAxis tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }} axisLine={false} tickLine={false} tickFormatter={(v: number) => v.toFixed(3)} width={48} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as TreasuryDay
              return (
                <TooltipShell
                  label={String(label)}
                  rows={[
                    { color: ZEC_COLOR, name: "ZEC / share", value: p.zecPerShare != null ? p.zecPerShare.toFixed(4) : "—" },
                    { color: TICK_FILL, name: "Treasury", value: `${fmtCount(p.treasuryZec)} ZEC` },
                  ]}
                />
              )
            }}
          />
          <Area type="monotone" dataKey="zecPerShare" stroke={ZEC_COLOR} strokeWidth={2} fill="url(#zps)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function PctOfSupplyChart({
  data,
  targetPct,
}: {
  data: TreasuryDay[]
  targetPct: number
}) {
  const points = data.filter((d) => d.pctOfSupply != null)
  const last = points[points.length - 1]
  return (
    <ChartCard
      title="Treasury vs. ZEC supply"
      subtitle="% of circulating ZEC the treasury holds. Dashed line is the stated target."
      meta={
        last?.pctOfSupply != null && (
          <span className="flex flex-col items-end leading-tight">
            <span className="text-foreground/80">
              {last.pctOfSupply.toFixed(3)}%
            </span>
            <span className="text-muted-foreground">target {targetPct}%</span>
          </span>
        )
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="pct-supply" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ZEC_COLOR} stopOpacity={0.35} />
              <stop offset="100%" stopColor={ZEC_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={MUTED_GRID} vertical={false} />
          <XAxis dataKey="date" tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }} axisLine={{ stroke: MUTED_AXIS }} tickLine={false} interval="preserveStartEnd" minTickGap={32} />
          <YAxis tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${v.toFixed(2)}%`} width={50} />
          <ReferenceLine
            y={targetPct}
            stroke={SKY}
            strokeDasharray="4 4"
            strokeOpacity={0.6}
            label={{ value: `${targetPct}%`, position: "right", fill: SKY, fontSize: 10, fontFamily: "monospace" }}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as TreasuryDay
              return (
                <TooltipShell
                  label={String(label)}
                  rows={[
                    { color: ZEC_COLOR, name: "% of supply", value: p.pctOfSupply != null ? `${p.pctOfSupply.toFixed(3)}%` : "—" },
                    { color: TICK_FILL, name: "Held", value: `${fmtCount(p.treasuryZec)} ZEC` },
                  ]}
                />
              )
            }}
          />
          <Area type="monotone" dataKey="pctOfSupply" stroke={ZEC_COLOR} strokeWidth={2} fill="url(#pct-supply)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function VelocityChart({
  weeks,
}: {
  weeks: VelocityWeek[]
}) {
  const last = weeks[weeks.length - 1]
  return (
    <ChartCard
      title="Acquisition velocity"
      subtitle="Net ZEC added per ISO week (bars), with cumulative treasury size (line)."
      meta={
        last && (
          <span className="flex flex-col items-end leading-tight">
            <span className="text-foreground/80">
              +{fmtCount(last.net)} ZEC last wk
            </span>
            <span className="text-muted-foreground">
              total {fmtCount(last.cumulative)}
            </span>
          </span>
        )
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={weeks} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={MUTED_GRID} vertical={false} />
          <XAxis dataKey="date" tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }} axisLine={{ stroke: MUTED_AXIS }} tickLine={false} interval="preserveStartEnd" minTickGap={32} />
          <YAxis
            yAxisId="bars"
            tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}K` : `${v.toFixed(0)}`)}
            width={44}
          />
          <YAxis
            yAxisId="line"
            orientation="right"
            tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}K` : `${v.toFixed(0)}`)}
            width={48}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as VelocityWeek
              return (
                <TooltipShell
                  label={`Week of ${String(label)}`}
                  rows={[
                    { color: ZEC_COLOR, name: "Net adds", value: `${p.net >= 0 ? "+" : ""}${fmtCount(p.net)} ZEC` },
                    { color: SKY, name: "Cumulative", value: `${fmtCount(p.cumulative)} ZEC` },
                  ]}
                />
              )
            }}
          />
          <Bar yAxisId="bars" dataKey="net" fill={ZEC_COLOR} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          <Line yAxisId="line" type="monotone" dataKey="cumulative" stroke={SKY} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function CostBasisChart({ data }: { data: TreasuryDay[] }) {
  const points = data.filter((d) => d.avgCostPerZec != null && d.avgCostPerZec > 0)
  const last = points[points.length - 1]
  const underwater = last && last.avgCostPerZec != null && last.zec < last.avgCostPerZec
  return (
    <ChartCard
      title="Cost basis vs. ZEC spot"
      subtitle="Volume-weighted USD/ZEC paid (line) versus spot (line). Spot above cost = treasury in profit."
      meta={
        last && last.avgCostPerZec != null && (
          <span className="flex flex-col items-end leading-tight">
            <span className={underwater ? "text-red-400" : "text-green-400"}>
              {underwater ? "underwater" : "in profit"}
            </span>
            <span className="text-muted-foreground">
              avg {fmtUsd(last.avgCostPerZec, 0)} · spot {fmtUsd(last.zec, 0)}
            </span>
          </span>
        )
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={MUTED_GRID} vertical={false} />
          <XAxis dataKey="date" tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }} axisLine={{ stroke: MUTED_AXIS }} tickLine={false} interval="preserveStartEnd" minTickGap={32} />
          <YAxis tick={{ fill: TICK_FILL, fontSize: 10, fontFamily: "monospace" }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `$${v.toFixed(0)}`} width={48} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as TreasuryDay
              return (
                <TooltipShell
                  label={String(label)}
                  rows={[
                    { color: ZEC_COLOR, name: "Spot ZEC", value: fmtUsd(p.zec, 0) },
                    { color: SKY, name: "Avg cost", value: p.avgCostPerZec != null ? fmtUsd(p.avgCostPerZec, 0) : "—" },
                    {
                      color: TICK_FILL,
                      name: "P/L per ZEC",
                      value:
                        p.avgCostPerZec != null
                          ? fmtUsd(p.zec - p.avgCostPerZec, 0)
                          : "—",
                    },
                  ]}
                />
              )
            }}
          />
          <Line type="monotone" dataKey="zec" stroke={ZEC_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="avgCostPerZec" stroke={SKY} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// ─── public component ────────────────────────────────────────────────────────

export function HoldingsCharts({ targetPct = 5 }: { targetPct?: number }) {
  const { series, velocity, hasShares, loading } = useTreasuryHistory()

  if (loading && series.length === 0) {
    return (
      <p className="text-sm text-muted-foreground p-2">
        Loading treasury history…
      </p>
    )
  }
  if (series.length === 0) {
    return (
      <p className="text-sm text-destructive-foreground p-2">
        Couldn&rsquo;t replay treasury history right now. Try again in a bit.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <SectionHeader
        label="Valuation"
        hint="how the market is pricing CYPH vs. its underlying ZEC"
      />
      <MNavChart data={series} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <McapRatioChart data={series} />
        <ImpliedZecChart data={series} />
      </div>

      <SectionHeader
        label="Treasury growth"
        hint="size + composition of the underlying ZEC stack"
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <ZecPerShareChart data={series} />
        <PctOfSupplyChart data={series} targetPct={targetPct} />
      </div>
      <VelocityChart weeks={velocity} />

      <SectionHeader
        label="Cost performance"
        hint="treasury cost basis vs. live ZEC price"
      />
      <CostBasisChart data={series} />

      <p className="text-[10px] font-mono text-muted-foreground/70 leading-relaxed pt-1">
        Per-share metrics use the latest reported shares-outstanding figure
        applied to the full window — Yahoo only updates this each
        10-Q/10-K, so a recent issuance can briefly under-state historical
        per-share values until the next filing.
        {!hasShares &&
          " Shares outstanding currently unavailable from upstream — per-share charts will populate once it returns."}
        {" "}ZEC market-cap history beyond CoinGecko&rsquo;s 30-day window
        is approximated as <code>price × current circulating supply</code>;
        ZEC supply growth is ~5%/yr, so the older end of the chart slightly
        under-counts circulating but the trend is preserved.
      </p>
    </div>
  )
}
