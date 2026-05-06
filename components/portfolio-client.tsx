"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import Link from "next/link"
import {
  ArrowLeft,
  TrendingUp,
  TrendingDown,
  Lock,
  RotateCcw,
  Wallet,
  Pencil,
} from "lucide-react"
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts"
import { PerfChip } from "@/components/perf-chip"

// ────────────────────────────────────────────────────────────────────────────
// Storage
// ────────────────────────────────────────────────────────────────────────────

/** Bumping the suffix forces a clean migration if the schema ever changes. */
const STORAGE_KEY = "cyphzec.portfolio.v1"

interface Holdings {
  cyphShares: number | null
  zecCoins: number | null
}

const EMPTY_HOLDINGS: Holdings = { cyphShares: null, zecCoins: null }

function readHoldings(): Holdings {
  if (typeof window === "undefined") return EMPTY_HOLDINGS
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY_HOLDINGS
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
    return EMPTY_HOLDINGS
  }
}

function writeHoldings(h: Holdings) {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(h))
  } catch {
    /* quota / private mode — silently swallow */
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Data fetching
// ────────────────────────────────────────────────────────────────────────────

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const json = await res.json()
  if (!res.ok || (json && typeof json === "object" && "error" in json)) {
    throw new Error(json?.error ?? `Request failed: ${res.status}`)
  }
  return json
}

interface PriceData {
  history: {
    timestamp: number
    date: string
    cyph: number
    zec: number
    ratio: number | null
  }[]
  current: {
    cyph: { price: number | null; change24h: number | null }
    zec: { price: number | null; change24h: number | null }
  }
}

interface QuoteSnapshot {
  marketState: string
  regularMarketPrice: number | null
  preMarketPrice: number | null
  preMarketTime: number | null
  postMarketPrice: number | null
  postMarketTime: number | null
  overnightMarketPrice: number | null
  overnightMarketTime: number | null
}

// ────────────────────────────────────────────────────────────────────────────
// Formatting
// ────────────────────────────────────────────────────────────────────────────

const CYPH_COLOR = "#34d399"
const ZEC_COLOR = "#fb923c"

function fmtUSD(n: number | null, opts: Intl.NumberFormatOptions = {}) {
  if (n == null || !Number.isFinite(n)) return "—"
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...opts,
  })
}

function fmtUnits(n: number | null) {
  if (n == null || !Number.isFinite(n)) return "—"
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 })
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 })
}

function fmtPct(p: number | null, withSign = true) {
  if (p == null || !Number.isFinite(p)) return "—"
  const sign = withSign && p > 0 ? "+" : ""
  return `${sign}${p.toFixed(2)}%`
}

function fmtSignedUSD(n: number | null) {
  if (n == null || !Number.isFinite(n)) return "—"
  const sign = n > 0 ? "+" : n < 0 ? "−" : ""
  return `${sign}${fmtUSD(Math.abs(n))}`
}

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

export function PortfolioClient() {
  // ── Holdings state ──
  const [holdings, setHoldings] = useState<Holdings>(EMPTY_HOLDINGS)
  const [hydrated, setHydrated] = useState(false)
  // When holdings exist, the inputs collapse to a one-line summary with an
  // Edit button; clicking expands the full form. Empty state always shows
  // the form.
  const [editing, setEditing] = useState(false)
  // Hydrate on mount to avoid a SSR/CSR mismatch warning — localStorage is
  // browser-only, so we render the empty form on first paint and swap in
  // saved values right after.
  useEffect(() => {
    setHoldings(readHoldings())
    setHydrated(true)
  }, [])
  useEffect(() => {
    if (hydrated) writeHoldings(holdings)
  }, [holdings, hydrated])

  // ── Live data ──
  const { data: priceData } = useSWR<PriceData>(
    "/api/prices?days=all",
    fetcher,
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    }
  )
  const { data: quoteData } = useSWR<QuoteSnapshot>("/api/quote", fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    keepPreviousData: true,
  })

  // Use whichever CYPH price is live right now: regular if open, freshest
  // extended-hours print otherwise. Falls back to the /api/prices regular
  // close if /api/quote is briefly unreachable.
  const liveCyph = useMemo<number | null>(() => {
    if (!quoteData) return priceData?.current?.cyph?.price ?? null
    if (quoteData.marketState === "REGULAR") {
      return quoteData.regularMarketPrice ?? null
    }
    const candidates: { price: number; time: number }[] = []
    for (const s of ["overnight", "post", "pre"] as const) {
      const p = quoteData[`${s}MarketPrice` as const]
      const t = quoteData[`${s}MarketTime` as const]
      if (p != null && t != null) candidates.push({ price: p, time: t })
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.time - a.time)
      return candidates[0].price
    }
    return quoteData.regularMarketPrice ?? null
  }, [quoteData, priceData])
  const liveZec = priceData?.current?.zec?.price ?? null

  const cyphValue =
    holdings.cyphShares != null && liveCyph != null
      ? holdings.cyphShares * liveCyph
      : null
  const zecValue =
    holdings.zecCoins != null && liveZec != null
      ? holdings.zecCoins * liveZec
      : null
  const totalValue =
    cyphValue == null && zecValue == null ? null : (cyphValue ?? 0) + (zecValue ?? 0)

  // ── Period changes ──
  const history = priceData?.history ?? []

  /** Compute portfolio value approximately N calendar days ago, using the
   *  most recent daily close on or before the cutoff. */
  function valueNDaysAgo(daysBack: number): number | null {
    if (history.length === 0) return null
    const cutoffMs = Date.now() - daysBack * 86400_000
    let last: (typeof history)[number] | null = null
    for (const h of history) {
      if (h.timestamp > cutoffMs) break
      last = h
    }
    if (!last) return null
    const cyphPart =
      holdings.cyphShares != null ? holdings.cyphShares * last.cyph : 0
    const zecPart = holdings.zecCoins != null ? holdings.zecCoins * last.zec : 0
    return cyphPart + zecPart
  }

  function pctChangeFrom(then: number | null): number | null {
    if (then == null || then === 0 || totalValue == null) return null
    return ((totalValue - then) / then) * 100
  }
  function dollarChangeFrom(then: number | null): number | null {
    if (then == null || totalValue == null) return null
    return totalValue - then
  }

  const value24hAgo = valueNDaysAgo(1)
  const change24hPct = pctChangeFrom(value24hAgo)
  const change24hUSD = dollarChangeFrom(value24hAgo)
  const change7d = pctChangeFrom(valueNDaysAgo(7))
  const change30d = pctChangeFrom(valueNDaysAgo(30))
  const change90d = pctChangeFrom(valueNDaysAgo(90))

  // ── Chart series ──
  const chartData = useMemo(() => {
    if (history.length === 0) return []
    const cyphShares = holdings.cyphShares ?? 0
    const zecCoins = holdings.zecCoins ?? 0
    if (cyphShares === 0 && zecCoins === 0) return []
    return history.map((h) => ({
      timestamp: h.timestamp,
      date: h.date,
      value: cyphShares * h.cyph + zecCoins * h.zec,
      cyph: cyphShares * h.cyph,
      zec: zecCoins * h.zec,
    }))
  }, [history, holdings])

  // ── Allocation ──
  const totalForAlloc = (cyphValue ?? 0) + (zecValue ?? 0)
  const cyphPct =
    totalForAlloc > 0 && cyphValue != null ? (cyphValue / totalForAlloc) * 100 : null
  const zecPct =
    totalForAlloc > 0 && zecValue != null ? (zecValue / totalForAlloc) * 100 : null

  const hasHoldings =
    (holdings.cyphShares ?? 0) > 0 || (holdings.zecCoins ?? 0) > 0

  // ── Input handlers ──
  function onChangeCyph(raw: string) {
    if (raw === "") {
      setHoldings((h) => ({ ...h, cyphShares: null }))
      return
    }
    const num = parseFloat(raw.replace(/[, ]/g, ""))
    if (Number.isFinite(num) && num >= 0) {
      setHoldings((h) => ({ ...h, cyphShares: num }))
    }
  }
  function onChangeZec(raw: string) {
    if (raw === "") {
      setHoldings((h) => ({ ...h, zecCoins: null }))
      return
    }
    const num = parseFloat(raw.replace(/[, ]/g, ""))
    if (Number.isFinite(num) && num >= 0) {
      setHoldings((h) => ({ ...h, zecCoins: num }))
    }
  }
  function clearAll() {
    setHoldings(EMPTY_HOLDINGS)
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Holdings input — shows as a compact summary line once values are
          entered, with a click-to-edit affordance. Empty state always
          shows the full form so first-time users have an obvious entry
          point. */}
      {hasHoldings && hydrated && !editing ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="Edit your holdings"
          className="group rounded-lg border border-border bg-card hover:bg-card/80 transition-colors px-3 py-2 flex items-center gap-3 text-xs font-mono text-left"
        >
          <Wallet className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Holdings
          </span>
          <span className="flex-1 min-w-0 flex items-baseline gap-x-3 gap-y-0.5 flex-wrap">
            {holdings.cyphShares != null && holdings.cyphShares > 0 && (
              <span>
                <span className="text-foreground font-bold">
                  {fmtUnits(holdings.cyphShares)}
                </span>{" "}
                <span style={{ color: CYPH_COLOR }}>$CYPH</span>
              </span>
            )}
            {holdings.zecCoins != null && holdings.zecCoins > 0 && (
              <span>
                <span className="text-foreground font-bold">
                  {fmtUnits(holdings.zecCoins)}
                </span>{" "}
                <span style={{ color: ZEC_COLOR }}>$ZEC</span>
              </span>
            )}
          </span>
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground group-hover:text-foreground transition-colors">
            <Pencil className="h-3 w-3" />
            Edit
          </span>
        </button>
      ) : (
        <section
          aria-labelledby="holdings-heading"
          className="rounded-lg border border-border bg-card p-3 md:p-4 flex flex-col gap-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h2
              id="holdings-heading"
              className="text-xs font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"
            >
              <Wallet className="h-3.5 w-3.5" />
              Your Holdings
            </h2>
            <div className="flex items-center gap-3">
              {hasHoldings && (
                <button
                  onClick={clearAll}
                  className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors"
                  title="Clear all holdings"
                >
                  <RotateCcw className="h-3 w-3" />
                  Clear
                </button>
              )}
              {hasHoldings && (
                <button
                  onClick={() => setEditing(false)}
                  className="text-[10px] font-mono text-primary hover:text-primary/80 transition-colors"
                >
                  Done
                </button>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: CYPH_COLOR }}
                />
                $CYPH shares
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={
                  hydrated && holdings.cyphShares != null
                    ? String(holdings.cyphShares)
                    : ""
                }
                onChange={(e) => onChangeCyph(e.target.value)}
                placeholder="0"
                aria-label="CYPH shares held"
                className="bg-secondary rounded px-3 py-2 text-lg font-mono font-bold text-foreground outline-none focus:ring-2 focus:ring-primary/40 placeholder:text-muted-foreground/40"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: ZEC_COLOR }}
                />
                $ZEC coins
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={
                  hydrated && holdings.zecCoins != null
                    ? String(holdings.zecCoins)
                    : ""
                }
                onChange={(e) => onChangeZec(e.target.value)}
                placeholder="0.0"
                aria-label="ZEC coins held"
                className="bg-secondary rounded px-3 py-2 text-lg font-mono font-bold text-foreground outline-none focus:ring-2 focus:ring-primary/40 placeholder:text-muted-foreground/40"
              />
            </label>
          </div>
          <p className="text-[10px] font-mono text-muted-foreground/70 flex items-center gap-1.5">
            <Lock className="h-3 w-3" />
            Saved only on this device. Nothing leaves your browser.
          </p>
        </section>
      )}

      {/* Empty state */}
      {!hasHoldings && hydrated && (
        <section className="rounded-lg border border-dashed border-border bg-card/40 p-6 text-center flex flex-col gap-1">
          <p className="text-sm font-mono text-muted-foreground">
            Enter your $CYPH and / or $ZEC holdings above to see live total
            value, period performance, and a portfolio chart.
          </p>
        </section>
      )}

      {/* Total value card */}
      {hasHoldings && hydrated && (
        <section
          aria-labelledby="total-heading"
          className="rounded-lg border bg-card p-3 md:p-4 flex flex-col gap-2"
          style={{ borderColor: "#38bdf844" }}
        >
          <h2
            id="total-heading"
            className="text-xs font-mono uppercase tracking-wider text-muted-foreground"
          >
            Total Portfolio Value
          </h2>
          <div className="flex items-end gap-3 flex-wrap">
            <p className="text-3xl md:text-4xl font-mono font-bold text-foreground leading-none">
              {fmtUSD(totalValue)}
            </p>
            {change24hPct != null && (
              <div
                className={`flex items-center gap-1 text-sm font-mono pb-0.5 ${
                  change24hPct >= 0 ? "text-green-400" : "text-red-400"
                }`}
              >
                {change24hPct >= 0 ? (
                  <TrendingUp className="h-3.5 w-3.5" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5" />
                )}
                <span>{fmtSignedUSD(change24hUSD)}</span>
                <span className="opacity-75">({fmtPct(change24hPct)})</span>
                <span className="opacity-60 ml-1">24h</span>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <PerfChip label="24h" pct={change24hPct} />
            <PerfChip label="7D" pct={change7d} />
            <PerfChip label="30D" pct={change30d} />
            <PerfChip label="90D" pct={change90d} />
          </div>
        </section>
      )}

      {/* Asset breakdown — CYPH vs ZEC */}
      {hasHoldings && hydrated && (
        <section
          aria-labelledby="breakdown-heading"
          className="rounded-lg border border-border bg-card p-3 md:p-4 flex flex-col gap-3"
        >
          <h2
            id="breakdown-heading"
            className="text-xs font-mono uppercase tracking-wider text-muted-foreground"
          >
            Breakdown
          </h2>

          {/* Allocation bar */}
          {cyphPct != null && zecPct != null && (
            <div className="h-2 w-full rounded-full overflow-hidden bg-secondary flex">
              <div
                className="h-full"
                style={{
                  width: `${cyphPct}%`,
                  backgroundColor: CYPH_COLOR,
                }}
                aria-label={`CYPH allocation: ${cyphPct.toFixed(1)}%`}
              />
              <div
                className="h-full"
                style={{
                  width: `${zecPct}%`,
                  backgroundColor: ZEC_COLOR,
                }}
                aria-label={`ZEC allocation: ${zecPct.toFixed(1)}%`}
              />
            </div>
          )}

          {/* Per-asset rows */}
          <div className="flex flex-col gap-2 text-sm font-mono">
            <AssetRow
              label="$CYPH"
              sublabel="Cypherpunk Technologies"
              color={CYPH_COLOR}
              units={holdings.cyphShares}
              unitsSuffix="shares"
              price={liveCyph}
              value={cyphValue}
              alloc={cyphPct}
            />
            <AssetRow
              label="$ZEC"
              sublabel="Zcash"
              color={ZEC_COLOR}
              units={holdings.zecCoins}
              unitsSuffix="coins"
              price={liveZec}
              value={zecValue}
              alloc={zecPct}
            />
          </div>
        </section>
      )}

      {/* Portfolio value chart */}
      {hasHoldings && hydrated && chartData.length > 1 && (
        <section
          aria-labelledby="chart-heading"
          className="rounded-lg border border-border bg-card p-3 md:p-4 flex flex-col gap-3"
        >
          <h2
            id="chart-heading"
            className="text-xs font-mono uppercase tracking-wider text-muted-foreground"
          >
            Portfolio Value Over Time
          </h2>
          <div className="h-56 md:h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="totalFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
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
                      ? `$${(v / 1000).toFixed(1)}k`
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
                  formatter={(value, key) => {
                    const label =
                      key === "value"
                        ? "Total"
                        : key === "cyph"
                          ? "$CYPH"
                          : "$ZEC"
                    return [fmtUSD(Number(value)), label]
                  }}
                  labelStyle={{ color: "#9ca3af" }}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="#38bdf8"
                  strokeWidth={2}
                  fill="url(#totalFill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[10px] font-mono text-muted-foreground/70">
            Computed from daily closes assuming a constant {holdings.cyphShares != null && `${fmtUnits(holdings.cyphShares)} $CYPH`}
            {holdings.cyphShares != null && holdings.zecCoins != null && " + "}
            {holdings.zecCoins != null && `${fmtUnits(holdings.zecCoins)} $ZEC`} held throughout.
          </p>
        </section>
      )}

      {/* Disclaimer */}
      <p className="text-[10px] font-mono text-muted-foreground/60 leading-relaxed text-center max-w-prose mx-auto pt-1">
        For informational purposes only. Past performance does not predict
        future results. Not investment advice.
      </p>

      <Link
        href="/"
        className="self-start flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors pt-1"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to dashboard
      </Link>
    </div>
  )
}

function AssetRow({
  label,
  sublabel,
  color,
  units,
  unitsSuffix,
  price,
  value,
  alloc,
}: {
  label: string
  sublabel: string
  color: string
  units: number | null
  unitsSuffix: string
  price: number | null
  value: number | null
  alloc: number | null
}) {
  // Two-row deterministic layout. Both assets render with the same
  // structure regardless of label-text length so they line up vertically:
  //   row 1: [● ticker · sublabel]               [USD value]
  //   row 2: [units × unit price]                [allocation %]
  // Allocation is rendered in muted text — green/red are reserved for
  // gain/loss elsewhere on the page, so coloring an allocation chip in
  // the asset's brand tint here would imply movement that isn't there.
  return (
    <div
      className="rounded-md border bg-card p-2.5 flex flex-col gap-1"
      style={{ borderColor: `${color}33` }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="h-2 w-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: color }}
          />
          <span className="text-foreground font-bold whitespace-nowrap">
            {label}
          </span>
          <span className="text-[10px] text-muted-foreground truncate">
            {sublabel}
          </span>
        </div>
        <span className="text-foreground font-bold text-sm whitespace-nowrap">
          {fmtUSD(value)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-muted-foreground">
        <span className="flex items-baseline gap-1.5 truncate">
          <span>
            {fmtUnits(units)} {unitsSuffix}
          </span>
          <span className="text-muted-foreground/50">×</span>
          <span>{fmtUSD(price)}</span>
        </span>
        {alloc != null && (
          <span className="text-muted-foreground whitespace-nowrap">
            {alloc.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  )
}
