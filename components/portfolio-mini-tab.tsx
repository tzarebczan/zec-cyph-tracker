"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts"
import { TrendingUp, TrendingDown } from "lucide-react"
import { PerfChip } from "@/components/perf-chip"

// Same key + schema the standalone /portfolio page writes to.
const STORAGE_KEY = "cyphzec.portfolio.v1"

interface Holdings {
  cyphShares: number | null
  zecCoins: number | null
}

const EMPTY: Holdings = { cyphShares: null, zecCoins: null }

function readHoldings(): Holdings {
  if (typeof window === "undefined") return EMPTY
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw)
    return {
      cyphShares:
        typeof parsed?.cyphShares === "number" && parsed.cyphShares >= 0
          ? parsed.cyphShares
          : null,
      zecCoins:
        typeof parsed?.zecCoins === "number" && parsed.zecCoins >= 0
          ? parsed.zecCoins
          : null,
    }
  } catch {
    return EMPTY
  }
}

/**
 * Hook used by the dashboard to gate the Portfolio chart tab. Subscribes
 * to the cross-tab `storage` event so changes saved on /portfolio reflect
 * here without a page reload. Same SSR-safe pattern as PortfolioClient
 * (empty on first paint, filled in after mount).
 */
export function usePortfolioHoldings() {
  const [holdings, setHoldings] = useState<Holdings>(EMPTY)
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    setHoldings(readHoldings())
    setHydrated(true)
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setHoldings(readHoldings())
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])
  const hasPortfolio =
    hydrated && ((holdings.cyphShares ?? 0) > 0 || (holdings.zecCoins ?? 0) > 0)
  return { holdings, hydrated, hasPortfolio }
}

interface HistoryPoint {
  timestamp: number
  date: string
  cyph: number
  zec: number
}

interface Props {
  holdings: Holdings
  /** History from the dashboard's existing /api/prices fetch (already
   *  augmented with the live tip). The mini chart respects whatever
   *  period the user has selected on the dashboard. */
  history: HistoryPoint[]
  liveCyph: number | null
  liveZec: number | null
}

const TOTAL_COLOR = "#38bdf8"
const CYPH_COLOR = "#34d399"
const ZEC_COLOR = "#fb923c"

function fmtUSD(n: number | null) {
  if (n == null || !Number.isFinite(n)) return "—"
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
function fmtCompactUSD(n: number) {
  if (Math.abs(n) >= 1_000_000)
    return `$${(n / 1_000_000).toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 2,
    })}M`
  if (Math.abs(n) >= 1000)
    return `$${(n / 1000).toLocaleString("en-US", {
      maximumFractionDigits: 1,
    })}k`
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}
function fmtSignedUSD(n: number | null) {
  if (n == null || !Number.isFinite(n)) return "—"
  const sign = n > 0 ? "+" : n < 0 ? "−" : ""
  return `${sign}${fmtUSD(Math.abs(n))}`
}

export function PortfolioMiniTab({
  holdings,
  history,
  liveCyph,
  liveZec,
}: Props) {
  const cyphShares = holdings.cyphShares ?? 0
  const zecCoins = holdings.zecCoins ?? 0

  // Total live portfolio value, using the same toggle/state-aware
  // CYPH price the dashboard ratio uses + the live Kraken ZEC tick.
  const totalValue =
    (liveCyph != null ? cyphShares * liveCyph : 0) +
    (liveZec != null ? zecCoins * liveZec : 0)

  // Helper: total value approximately N calendar days ago, by walking
  // the daily history (most recent ≤ cutoff timestamp wins).
  function valueNDaysAgo(daysBack: number): number | null {
    if (history.length === 0) return null
    const cutoffMs = Date.now() - daysBack * 86400_000
    let last: HistoryPoint | null = null
    for (const h of history) {
      if (h.timestamp > cutoffMs) break
      last = h
    }
    if (!last) return null
    return cyphShares * last.cyph + zecCoins * last.zec
  }
  function pctFrom(then: number | null): number | null {
    if (then == null || then === 0 || totalValue === 0) return null
    return ((totalValue - then) / then) * 100
  }
  const value24hAgo = valueNDaysAgo(1)
  const change24hUSD =
    value24hAgo != null ? totalValue - value24hAgo : null
  const change24hPct = pctFrom(value24hAgo)
  const change7d = pctFrom(valueNDaysAgo(7))
  const change30d = pctFrom(valueNDaysAgo(30))
  const change90d = pctFrom(valueNDaysAgo(90))

  // Mini chart data: total value over the selected period.
  const chartData = useMemo(() => {
    if (history.length === 0) return []
    return history.map((h) => ({
      timestamp: h.timestamp,
      date: h.date,
      value: cyphShares * h.cyph + zecCoins * h.zec,
    }))
  }, [history, cyphShares, zecCoins])

  return (
    <div className="h-full flex flex-col gap-2">
      {/* Row 1 — single line: total + signed 24h delta. The dollar amount
          of the 24h delta lives below in the asset breakdown row, so the
          headline only carries the number + percent (won't wrap on mobile). */}
      <div className="flex items-baseline justify-between gap-3 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <p className="text-xl md:text-2xl font-mono font-bold text-foreground leading-none truncate">
            {fmtUSD(totalValue)}
          </p>
          {change24hPct != null && (
            <span
              className={`flex items-center gap-0.5 text-xs font-mono pb-0.5 whitespace-nowrap ${
                change24hPct >= 0 ? "text-green-400" : "text-red-400"
              }`}
            >
              {change24hPct >= 0 ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              {change24hPct >= 0 ? "+" : ""}
              {change24hPct.toFixed(2)}%
              <span className="opacity-60 ml-1">24h</span>
            </span>
          )}
        </div>
        <Link
          href="/portfolio"
          className="text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline whitespace-nowrap pb-0.5"
        >
          Detail &rarr;
        </Link>
      </div>

      {/* Row 2 — single line: signed dollar delta + per-asset breakdown.
          Shows the 24h $ change (which we dropped from row 1) AND how
          the total decomposes into CYPH / ZEC, all in one inline run. */}
      <div className="flex items-baseline gap-x-3 gap-y-0.5 text-[11px] font-mono text-muted-foreground flex-wrap">
        {change24hUSD != null && (
          <span
            className={`whitespace-nowrap ${
              change24hUSD >= 0 ? "text-green-400/80" : "text-red-400/80"
            }`}
          >
            {fmtSignedUSD(change24hUSD)} 24h
          </span>
        )}
        {cyphShares > 0 && liveCyph != null && (
          <span className="whitespace-nowrap">
            <span style={{ color: CYPH_COLOR }}>$CYPH</span>{" "}
            <span className="text-foreground/80">
              {fmtCompactUSD(cyphShares * liveCyph)}
            </span>
          </span>
        )}
        {zecCoins > 0 && liveZec != null && (
          <span className="whitespace-nowrap">
            <span style={{ color: ZEC_COLOR }}>$ZEC</span>{" "}
            <span className="text-foreground/80">
              {fmtCompactUSD(zecCoins * liveZec)}
            </span>
          </span>
        )}
      </div>

      {/* Row 3 — single line: the four perf chips, no asset chips here.
          Asset breakdown is in row 2 so this row stays four chips wide,
          which fits comfortably on every viewport down to 320px. */}
      <div className="flex flex-wrap gap-1.5">
        <PerfChip label="24h" pct={change24hPct} />
        <PerfChip label="7D" pct={change7d} />
        <PerfChip label="30D" pct={change30d} />
        <PerfChip label="90D" pct={change90d} />
      </div>

      {/* Mini chart */}
      <div className="flex-1 min-h-0">
        {chartData.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="ptfFill" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor={TOTAL_COLOR}
                    stopOpacity={0.4}
                  />
                  <stop
                    offset="100%"
                    stopColor={TOTAL_COLOR}
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                stroke="#6b7280"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                minTickGap={32}
              />
              <YAxis
                stroke="#6b7280"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) =>
                  typeof v === "number" && v >= 1000
                    ? `$${(v / 1000).toFixed(0)}k`
                    : `$${Number(v).toFixed(0)}`
                }
                width={48}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#0b0f14",
                  border: "1px solid #1f2937",
                  borderRadius: "6px",
                  fontFamily: "monospace",
                  fontSize: "12px",
                }}
                formatter={(value) => [fmtUSD(Number(value)), "Total"]}
                labelStyle={{ color: "#9ca3af" }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={TOTAL_COLOR}
                strokeWidth={2}
                fill="url(#ptfFill)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full flex items-center justify-center text-xs font-mono text-muted-foreground">
            Not enough history to chart yet.
          </div>
        )}
      </div>
    </div>
  )
}
