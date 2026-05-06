"use client"

import { useState } from "react"
import useSWR, { useSWRConfig } from "swr"
import { RefreshCw, Activity, TrendingUp, BarChart2, Calculator, ChevronRight } from "lucide-react"
import { StatCard } from "@/components/stat-card"
import { PriceChart } from "@/components/price-chart"
import { RatioChart } from "@/components/ratio-chart"
import Link from "next/link"
import { CyphExtendedQuote } from "@/components/cyph-extended-quote"
import { PerfChip } from "@/components/perf-chip"

const PERIODS = [
  { label: "7D", value: "7" },
  { label: "14D", value: "14" },
  { label: "30D", value: "30" },
  { label: "90D", value: "90" },
  { label: "6M", value: "180" },
  { label: "All", value: "all" },
]

interface Stats {
  cyph: {
    change24h: number | null
    change7d: number | null
    change30d: number | null
    change90d: number | null
  }
  zec: {
    change24h: number | null
    change7d: number | null
    change30d: number | null
    change90d: number | null
  }
  ratio: {
    avg24h: number | null
    avg7d: number | null
    avg30d: number | null
    vsAvg24h: number | null
    vsAvg7d: number | null
    vsAvg30d: number | null
  }
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
  stats?: Stats
}

/** Subset of /api/quote we need to compute the live ratio. The CYPH card
 *  also subscribes to this key — SWR will dedupe, no double-fetch. */
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

/** Throwing fetcher so SWR registers upstream failures and triggers retries.
 *  Without this, a 500 response (or { error: "…" } JSON body) would still
 *  resolve as `data`, SWR would see no error, and the page would stop
 *  auto-recovering — same bug class that left the tab stuck on "Retry"
 *  for the CYPH quote before. */
const fetcher = async (url: string) => {
  const res = await fetch(url)
  const json = await res.json()
  if (!res.ok || (json && typeof json === "object" && "error" in json)) {
    throw new Error(json?.error ?? `Request failed: ${res.status}`)
  }
  return json
}

const CYPH_COLOR = "#34d399"
const ZEC_COLOR = "#fb923c"

export function PriceDashboard() {
  const [days, setDays] = useState("90")
  const [chartTab, setChartTab] = useState<"prices" | "ratio">("prices")
  const [showExtended, setShowExtended] = useState(true)

  const { data, error, isLoading, isValidating, mutate } = useSWR<PriceData>(
    `/api/prices?days=${days}`,
    fetcher,
    {
      refreshInterval: 60_000,
      // Auto-recover when the user comes back to a backgrounded tab or the
      // network reconnects — same contract as the CYPH quote, so ZEC and
      // CYPH refresh together instead of needing a manual reload.
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      focusThrottleInterval: 0,
      shouldRetryOnError: true,
      // Never give up: capped exponential backoff so a long Yahoo / Kraken
      // outage doesn't leave the dashboard frozen on stale data.
      onErrorRetry: (_err, _key, _config, revalidate, { retryCount }) => {
        const waitSec = Math.min(300, 15 * Math.pow(2, Math.min(retryCount, 5)))
        setTimeout(() => revalidate({ retryCount: retryCount + 1 }), waitSec * 1000)
      },
      // Keep the last-known prices on screen while retries run.
      keepPreviousData: true,
    }
  )

  // Pull the live CYPH quote here too, so the ratio card can show a truly
  // realtime ratio (live CYPH / live ZEC) instead of yesterday's daily close.
  // Same SWR key as CyphExtendedQuote — deduped to a single network call.
  const { data: quoteData } = useSWR<QuoteSnapshot>("/api/quote", fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    keepPreviousData: true,
  })

  // Only surface a hard error to the user when we genuinely have nothing to
  // show. With keepPreviousData, a transient fetch failure leaves the last
  // good prices on screen and a retry is already scheduled — flashing a
  // destructive banner in that case just creates noise.
  const hasUsableData = data != null && Array.isArray((data as PriceData).history)
  const hasError = !!error && !hasUsableData

  // Coordinate manual refresh across BOTH SWR keys: /api/prices (this hook)
  // and /api/quote (owned by CyphExtendedQuote). Without this the header
  // refresh only revalidated /api/prices, leaving the live CYPH price stale.
  const { mutate: globalMutate } = useSWRConfig()
  const [manualRefreshing, setManualRefreshing] = useState(false)
  const refreshAll = async () => {
    setManualRefreshing(true)
    try {
      await Promise.all([mutate(), globalMutate("/api/quote")])
    } finally {
      setManualRefreshing(false)
    }
  }
  // Spinner reflects any active fetch — initial load, background refresh,
  // SWR auto-revalidation, or a manual click. `isLoading` alone only covers
  // the initial fetch, so the click felt unresponsive previously.
  const refreshSpinning = manualRefreshing || isValidating || isLoading

  // Safely extract history and current — guard against undefined or error-shape responses
  const history = Array.isArray(data?.history) ? data!.history : []
  const currentZec =
    data != null && "current" in data ? data.current?.zec ?? null : null
  const stats: Stats | null =
    data != null && "stats" in data ? (data.stats as Stats) ?? null : null

  // Derived ratio stats from the daily history (used as fallback + for averages)
  const ratioValues = history
    .map((d) => d.ratio ?? 0)
    .filter((v) => v > 0)
  const dailyCloseRatio =
    history.length > 0 ? (history[history.length - 1].ratio ?? null) : null
  const avgRatio =
    ratioValues.length > 0
      ? ratioValues.reduce((a, b) => a + b, 0) / ratioValues.length
      : null

  // Pick the CYPH price the ratio should be based on, given the toggle and
  // the current market state. Returns whether the chosen price is genuinely
  // live (intraday tick or extended-hours print) vs a stale regular close.
  function pickActiveCyph(
    q: QuoteSnapshot | undefined,
    extendedOn: boolean
  ): { price: number | null; isLive: boolean } {
    if (!q) return { price: null, isLive: false }

    // During regular market hours, regularMarketPrice IS the live intraday
    // tick. The toggle is irrelevant here — there's no "extended" to switch
    // to, and we shouldn't pretend it's a stale close.
    if (q.marketState === "REGULAR") {
      return { price: q.regularMarketPrice, isLive: true }
    }

    // Outside regular hours, the toggle picks between live extended-hours
    // and the previous regular close.
    if (extendedOn) {
      const candidates: { price: number; time: number }[] = []
      if (q.overnightMarketPrice != null && q.overnightMarketTime != null)
        candidates.push({ price: q.overnightMarketPrice, time: q.overnightMarketTime })
      if (q.postMarketPrice != null && q.postMarketTime != null)
        candidates.push({ price: q.postMarketPrice, time: q.postMarketTime })
      if (q.preMarketPrice != null && q.preMarketTime != null)
        candidates.push({ price: q.preMarketPrice, time: q.preMarketTime })
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.time - a.time)
        return { price: candidates[0].price, isLive: true }
      }
    }
    // Toggle off, or no extended-hours print available — show the close.
    return { price: q.regularMarketPrice, isLive: false }
  }

  const { price: cyphForRatio, isLive: ratioIsLive } = pickActiveCyph(
    quoteData,
    showExtended
  )
  const liveZec = currentZec?.price ?? null
  const liveRatio =
    cyphForRatio != null && liveZec != null && liveZec > 0
      ? cyphForRatio / liveZec
      : null

  // Display the live ratio when we have one; fall back to the daily close
  // ratio so the card still renders something during a /api/quote outage.
  const currentRatio = liveRatio ?? dailyCloseRatio
  const ratioVsAvg =
    currentRatio != null && avgRatio != null
      ? ((currentRatio - avgRatio) / avgRatio) * 100
      : null
  /** % difference between the *displayed* ratio and a server-provided
   *  rolling average (24h / 7d / 30d). */
  const vsAvgFor = (avg: number | null | undefined) =>
    currentRatio != null && avg != null && avg > 0
      ? ((currentRatio - avg) / avg) * 100
      : null

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {/* Header */}
      <header className="border-b border-border bg-card/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-3 py-2 flex items-center gap-2">
          {/* Title */}
          <div className="flex items-center gap-1.5 shrink-0">
            <Activity className="h-4 w-4 text-primary" />
            <h1 className="text-sm font-mono font-bold text-foreground tracking-wider whitespace-nowrap">
              <span aria-hidden="true">
                <span style={{ color: "#34d399" }}>$CYPH</span>
                <span className="text-muted-foreground mx-1">/</span>
                <span style={{ color: "#fb923c" }}>$ZEC</span>
              </span>
              {/* Descriptive label for screen readers and search engines.
                  Visual stays compact for the header bar. */}
              <span className="sr-only">
                CYPH stock price (Cypherpunk Technologies, NASDAQ) and Zcash (ZEC) price tracker, with the CYPH/ZEC ratio updated in real time
              </span>
            </h1>
          </div>

          {/* Period selector — scrollable on very small screens */}
          <div className="flex items-center gap-0.5 bg-secondary rounded-md p-0.5 overflow-x-auto flex-1 min-w-0">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                onClick={() => setDays(p.value)}
                className={`px-2.5 py-1 text-xs font-mono rounded whitespace-nowrap transition-colors flex-shrink-0 ${
                  days === p.value
                    ? "bg-primary text-primary-foreground font-bold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Refresh */}
          <button
            onClick={refreshAll}
            disabled={refreshSpinning}
            className="p-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 shrink-0"
            aria-label="Refresh data"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshSpinning ? "animate-spin" : ""}`} />
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-3 py-3 flex flex-col gap-3">
        {/* Error banner */}
        {hasError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 flex items-center justify-between gap-3">
            <p className="text-xs font-mono text-destructive-foreground">
              Failed to load price data — one of the upstream APIs may be temporarily unavailable.
            </p>
            <button
              onClick={refreshAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-destructive/50 text-xs font-mono text-destructive-foreground hover:bg-destructive/20 transition-colors shrink-0"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          </div>
        )}

        {/* Stat cards — single row on desktop: CYPH (wider, 2 cols) | ZEC | Ratio */}
        <section className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <CyphExtendedQuote
            showExtended={showExtended}
            onToggle={() => setShowExtended((v) => !v)}
            className="md:col-span-2"
            performance={stats?.cyph}
          />
          <StatCard
            label="Zcash"
            ticker="$ZEC"
            price={currentZec?.price ?? null}
            color={ZEC_COLOR}
            loading={isLoading}
            performance={stats?.zec}
          />

          {/* Ratio card */}
          <div
            className="rounded-lg border bg-card p-3 flex flex-col gap-1"
            style={{ borderColor: "#38bdf844" }}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="h-2 w-2 rounded-full bg-sky-400 flex-shrink-0" />
              <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                CYPH/ZEC Ratio
              </span>
              {/* Mode badge: mirrors the CYPH card's extended-hours toggle so
                  the user knows whether the ratio is computed from live
                  prices or the last regular close. */}
              <span
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono font-semibold ${
                  ratioIsLive
                    ? "bg-green-500/20 text-green-400 border-green-500/40"
                    : "bg-muted text-muted-foreground border-border"
                }`}
                title={
                  ratioIsLive
                    ? "Realtime: ratio is using a current intraday or extended-hours CYPH tick"
                    : "Close: ratio is using the last regular-session CYPH close"
                }
              >
                {ratioIsLive ? "REALTIME" : "CLOSE"}
              </span>
            </div>
            <p className="text-2xl font-mono font-bold text-foreground">
              {currentRatio != null
                ? currentRatio < 0.001
                  ? currentRatio.toExponential(3)
                  : currentRatio.toPrecision(4)
                : "—"}
            </p>
            <div className="flex items-center gap-4 text-xs font-mono text-muted-foreground">
              <span>
                Avg:{" "}
                <span className="text-sky-400">
                  {avgRatio != null
                    ? avgRatio < 0.001
                      ? avgRatio.toExponential(3)
                      : avgRatio.toPrecision(4)
                    : "—"}
                </span>
              </span>
              {ratioVsAvg != null && (
                <span
                  className={
                    ratioVsAvg >= 0 ? "text-green-400" : "text-red-400"
                  }
                >
                  {ratioVsAvg >= 0 ? "+" : ""}
                  {ratioVsAvg.toFixed(1)}% vs avg
                </span>
              )}
            </div>
            {/* Fixed-window vs-avg chips. Independent of chart period so the
                user always has a 24h/7d/30d frame of reference.
                Recomputed client-side off the active (toggle-aware) ratio so
                they stay in sync with the headline number — the server's
                pre-baked vsAvg values always use the regular-session price
                and would disagree when the toggle picks an extended print. */}
            {stats?.ratio && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                <PerfChip label="24h" pct={vsAvgFor(stats.ratio.avg24h)} />
                <PerfChip label="7D" pct={vsAvgFor(stats.ratio.avg7d)} />
                <PerfChip label="30D" pct={vsAvgFor(stats.ratio.avg30d)} />
              </div>
            )}
          </div>
        </section>

        {/* Tabbed chart section */}
        <section className="rounded-lg border border-border bg-card flex flex-col">
          {/* Tab bar */}
          <div className="flex items-center gap-0 border-b border-border">
            <button
              onClick={() => setChartTab("prices")}
              className={`flex items-center gap-2 px-4 py-3 text-xs font-mono font-semibold border-b-2 transition-colors ${
                chartTab === "prices"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <TrendingUp className="h-3.5 w-3.5" />
              Prices
            </button>
            <button
              onClick={() => setChartTab("ratio")}
              className={`flex items-center gap-2 px-4 py-3 text-xs font-mono font-semibold border-b-2 transition-colors ${
                chartTab === "ratio"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <BarChart2 className="h-3.5 w-3.5" />
              CYPH/ZEC Ratio
            </button>

            {/* Spacer + legend on right */}
            <div className="ml-auto pr-4 hidden md:flex items-center gap-4 text-xs font-mono">
              {chartTab === "prices" ? (
                <>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-0.5 w-4 rounded" style={{ backgroundColor: CYPH_COLOR }} />
                    <span style={{ color: CYPH_COLOR }}>$CYPH</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-0.5 w-4 rounded" style={{ backgroundColor: ZEC_COLOR }} />
                    <span style={{ color: ZEC_COLOR }}>$ZEC</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-4" style={{ borderTop: "1.5px dashed #38bdf8", display: "inline-block" }} />
                    <span className="text-sky-400">Ratio</span>
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  Rising = CYPH outperforming · Falling = ZEC outperforming
                </span>
              )}
            </div>
          </div>

          <div className="p-3">
            {/* Prices tab */}
            {chartTab === "prices" && (
              <div className="h-56 md:h-80">
                {isLoading ? (
                  <div className="h-full w-full flex items-center justify-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <RefreshCw className="h-6 w-6 animate-spin" />
                      <span className="text-xs font-mono">Loading…</span>
                    </div>
                  </div>
                ) : history.length > 0 ? (
                  <PriceChart data={history} />
                ) : (
                  <div className="h-full flex items-center justify-center text-xs font-mono text-muted-foreground">
                    No data available
                  </div>
                )}
              </div>
            )}

            {/* Ratio tab */}
            {chartTab === "ratio" && (
              <div className="h-56 md:h-80">
                {isLoading ? (
                  <div className="h-full w-full flex items-center justify-center">
                    <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : history.length > 0 ? (
                  <RatioChart data={history} />
                ) : (
                  <div className="h-full flex items-center justify-center text-xs font-mono text-muted-foreground">
                    No data available
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Prominent estimator CTA. Sits directly below the chart so the
            new feature gets visible real estate instead of blending into
            a footer text run. Button-styled with the brand primary so it
            reads as actionable. */}
        <Link
          href="/estimator"
          className="group rounded-lg border border-primary/40 bg-primary/[.07] hover:bg-primary/[.12] hover:border-primary/60 transition-colors px-3 py-2.5 flex items-center gap-3"
        >
          <Calculator className="h-5 w-5 text-primary flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-mono font-bold text-foreground">
              $CYPH Price Estimator
            </div>
            <div className="text-[11px] md:text-xs font-mono text-muted-foreground">
              Predict CYPH for any $ZEC price · historical lookback
            </div>
          </div>
          <span className="text-primary text-base group-hover:translate-x-0.5 transition-transform" aria-hidden="true">
            &rarr;
          </span>
        </Link>

        {/* Foldable About / SEO copy. Same body text as before — keeps
            the keyword content in the rendered HTML for indexing — but
            collapsed by default so it doesn't dominate the dashboard.
            <details> renders the inner prose into the DOM regardless of
            the open/closed state, which is what Google wants. */}
        <details className="group text-xs font-mono text-muted-foreground/80">
          <summary className="cursor-pointer text-center hover:text-foreground transition-colors list-none flex items-center justify-center gap-1.5 select-none">
            <ChevronRight className="h-3 w-3 group-open:rotate-90 transition-transform" />
            About cyphzec.com · FAQ
          </summary>
          <div className="leading-relaxed max-w-prose mx-auto pt-2 text-center text-[11px] text-muted-foreground/80 flex flex-col gap-2">
            <p>
              Live{" "}
              <strong className="text-foreground/90">$CYPH</strong> stock
              price (Cypherpunk Technologies, NASDAQ) and{" "}
              <strong className="text-foreground/90">$ZEC / Zcash</strong>{" "}
              price, plus the CYPH/ZEC ratio. Updates every 30 seconds,
              includes pre-market, after-hours, and overnight Blue Ocean
              ATS sessions.
            </p>
            <Link
              href="/about"
              className="text-primary underline-offset-2 hover:underline"
            >
              Read the full About &amp; FAQ &rarr;
            </Link>
          </div>
        </details>
      </main>
    </div>
  )
}
