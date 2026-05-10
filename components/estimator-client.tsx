"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import Link from "next/link"
import { ArrowLeft, Calculator } from "lucide-react"

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

const CYPH_COLOR = "#34d399"
const ZEC_COLOR = "#fb923c"

function fmtPriceCyph(p: number | null) {
  if (p == null) return "—"
  return p < 1
    ? `$${p.toFixed(4)}`
    : `$${p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtPriceZec(p: number | null) {
  if (p == null) return "—"
  return `$${p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtRatio(r: number | null) {
  if (r == null) return "—"
  return r < 0.001 ? r.toExponential(3) : r.toPrecision(4)
}

function fmtDateShort(ms: number) {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function daysAgo(ms: number) {
  const days = Math.round((Date.now() - ms) / 86400_000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  return `${days} days ago`
}

export function EstimatorClient() {
  // Pull the full history; we need it for both the moving-average
  // computations and the historical lookback.
  const { data, error, isLoading } = useSWR<PriceData>(
    "/api/prices?days=all",
    fetcher,
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    }
  )

  const history = data?.history ?? []
  const currentZec = data?.current?.zec?.price ?? null
  const currentCyph = data?.current?.cyph?.price ?? null

  const [targetText, setTargetText] = useState<string>("")
  const targetZec =
    targetText === ""
      ? currentZec
      : (() => {
          const parsed = parseFloat(targetText.replace(/[^0-9.]/g, ""))
          return Number.isFinite(parsed) && parsed > 0 ? parsed : null
        })()

  // Average ratio over the last N calendar days (or all history when
  // daysBack is null). We build all five up front so we can also derive
  // the prediction range without re-computing.
  const ratios = useMemo(() => {
    function compute(daysBack: number | null): number | null {
      const cutoffMs =
        daysBack != null ? Date.now() - daysBack * 86400_000 : -Infinity
      const slice = history.filter(
        (h) =>
          h.timestamp >= cutoffMs && h.ratio != null && (h.ratio as number) > 0
      )
      if (slice.length === 0) return null
      return (
        slice.reduce((s, h) => s + (h.ratio as number), 0) / slice.length
      )
    }
    const latestRow =
      history.length > 0 ? history[history.length - 1] : null
    return {
      latest:
        latestRow && latestRow.ratio != null && latestRow.ratio > 0
          ? latestRow.ratio
          : null,
      avg7d: compute(7),
      avg30d: compute(30),
      avg90d: compute(90),
      avgAll: compute(null),
    }
  }, [history])

  const predict = (ratio: number | null): number | null =>
    targetZec != null && ratio != null && ratio > 0 ? targetZec * ratio : null

  const rows: { label: string; ratio: number | null; price: number | null }[] = [
    { label: "Latest daily ratio", ratio: ratios.latest, price: predict(ratios.latest) },
    { label: "7-day average", ratio: ratios.avg7d, price: predict(ratios.avg7d) },
    { label: "30-day average", ratio: ratios.avg30d, price: predict(ratios.avg30d) },
    { label: "90-day average", ratio: ratios.avg90d, price: predict(ratios.avg90d) },
    { label: "All-time average", ratio: ratios.avgAll, price: predict(ratios.avgAll) },
  ]
  const validPrices = rows.flatMap((r) =>
    r.price != null && r.price > 0 ? [r.price] : []
  )
  const minPrice = validPrices.length ? Math.min(...validPrices) : null
  const maxPrice = validPrices.length ? Math.max(...validPrices) : null

  // Historical lookback: most recent dates where ZEC closed within 1% of
  // the target price. Skip the last 2 days so the answer is genuinely
  // "the last time" and doesn't overlap with the live tick.
  const lookback = useMemo(() => {
    if (targetZec == null) return []
    const tolerance = 0.01
    const min = targetZec * (1 - tolerance)
    const max = targetZec * (1 + tolerance)
    const cutoff = Date.now() - 2 * 86400_000
    return history
      .filter(
        (h) => h.zec >= min && h.zec <= max && h.timestamp < cutoff
      )
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 5)
  }, [history, targetZec])

  return (
    <div className="flex flex-col gap-4">
      {/* Live anchor row */}
      <section className="rounded-lg border border-border bg-card p-3 md:p-4 flex flex-col sm:flex-row sm:items-center sm:gap-6 gap-2">
        <div className="flex flex-col">
          <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
            Current $CYPH
          </span>
          <span className="text-xl font-mono font-bold" style={{ color: CYPH_COLOR }}>
            {fmtPriceCyph(currentCyph)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
            Current $ZEC
          </span>
          <span className="text-xl font-mono font-bold" style={{ color: ZEC_COLOR }}>
            {fmtPriceZec(currentZec)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
            Live ratio
          </span>
          <span className="text-xl font-mono font-bold text-sky-400">
            {currentCyph != null && currentZec != null && currentZec > 0
              ? fmtRatio(currentCyph / currentZec)
              : "—"}
          </span>
        </div>
      </section>

      {/* Target ZEC input */}
      <section className="rounded-lg border border-border bg-card p-3 md:p-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-mono text-muted-foreground">
            If $ZEC was at…
          </span>
          <div className="flex items-center gap-2">
            <span className="text-xl font-mono font-bold" style={{ color: ZEC_COLOR }}>
              $
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={targetText}
              onChange={(e) => setTargetText(e.target.value)}
              placeholder={
                currentZec != null ? currentZec.toFixed(2) : "525.00"
              }
              className="flex-1 min-w-0 bg-secondary rounded p-2 text-xl font-mono font-bold text-foreground outline-none focus:ring-2 focus:ring-primary/40"
            />
            {targetText !== "" && (
              <button
                onClick={() => setTargetText("")}
                className="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors px-2"
                aria-label="Reset to current ZEC"
              >
                reset
              </button>
            )}
          </div>
          {targetZec != null && currentZec != null && targetZec !== currentZec && (
            <span className="text-[10px] font-mono text-muted-foreground">
              {targetZec > currentZec ? "+" : ""}
              {(((targetZec - currentZec) / currentZec) * 100).toFixed(1)}%
              vs current $ZEC
            </span>
          )}
        </label>

        {/* Predicted CYPH table */}
        <div className="flex flex-col gap-1 pt-1">
          <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground uppercase tracking-wider pb-1 border-b border-border/50">
            <span>Method</span>
            <span className="flex gap-6">
              <span>Ratio</span>
              <span className="w-20 text-right">Predicted $CYPH</span>
            </span>
          </div>
          {rows.map((r) => (
            <div
              key={r.label}
              className="flex items-center justify-between text-sm font-mono py-1"
            >
              <span className="text-muted-foreground">{r.label}</span>
              <span className="flex gap-6 items-baseline">
                <span className="text-sky-400">{fmtRatio(r.ratio)}</span>
                <span
                  className="w-20 text-right font-bold"
                  style={{ color: CYPH_COLOR }}
                >
                  {fmtPriceCyph(r.price)}
                </span>
              </span>
            </div>
          ))}
          {minPrice != null && maxPrice != null && minPrice !== maxPrice && (
            <div className="flex items-center justify-between text-xs font-mono pt-2 border-t border-border/50">
              <span className="text-muted-foreground">Range</span>
              <span className="font-bold text-foreground">
                {fmtPriceCyph(minPrice)} — {fmtPriceCyph(maxPrice)}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Historical lookback */}
      <section className="rounded-lg border border-border bg-card p-3 md:p-4 flex flex-col gap-3">
        <h2 className="text-sm font-mono font-semibold text-foreground">
          Last time $ZEC was around{" "}
          <span style={{ color: ZEC_COLOR }}>
            {fmtPriceZec(targetZec)}
          </span>
        </h2>
        {isLoading && history.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading history…</p>
        ) : error && history.length === 0 ? (
          <p className="text-sm text-destructive-foreground">
            Couldn&rsquo;t load history.
          </p>
        ) : lookback.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            $ZEC has not closed within ±1% of{" "}
            {fmtPriceZec(targetZec)} since November 12, 2025 — try a
            different price.
          </p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm font-mono">
            {lookback.map((h) => (
              <li
                key={h.timestamp}
                className="flex items-center justify-between gap-3 border-b border-border/30 last:border-b-0 pb-2 last:pb-0"
              >
                <span className="text-muted-foreground">
                  {fmtDateShort(h.timestamp)}
                  <span className="ml-1 text-muted-foreground/60">
                    ({daysAgo(h.timestamp)})
                  </span>
                </span>
                <span className="flex items-baseline gap-3">
                  <span style={{ color: ZEC_COLOR }}>
                    {fmtPriceZec(h.zec)}
                  </span>
                  <span className="text-muted-foreground/60">→</span>
                  <span className="font-bold" style={{ color: CYPH_COLOR }}>
                    {fmtPriceCyph(h.cyph)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[10px] font-mono text-muted-foreground/70 pt-1">
          Matches use daily closes within ±1% of the target $ZEC price.
        </p>
      </section>

      {/* Disclaimer */}
      <p className="text-[10px] font-mono text-muted-foreground/60 leading-relaxed text-center max-w-prose mx-auto">
        Predictions are simple ratio extrapolations of historical data. They
        do not account for shares outstanding changes, additional ZEC
        accumulation, market sentiment, or anything else. Not investment
        advice.
      </p>

      <Link
        href="/"
        className="self-start flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors pt-1"
      >
        <ArrowLeft className="size-3.5" />
        Back to dashboard
      </Link>
    </div>
  )
}

export function EstimatorHeader() {
  return (
    <div className="flex items-center gap-2">
      <Calculator className="size-5 text-primary" />
      <h1 className="text-lg md:text-xl font-mono font-semibold text-foreground">
        $CYPH Price Estimator
      </h1>
    </div>
  )
}
