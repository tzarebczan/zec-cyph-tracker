"use client"

import Link from "next/link"
import { PerfChip } from "@/components/perf-chip"

function fmtCompactUSD(n: number | null) {
  if (n == null || !Number.isFinite(n)) return null
  const abs = Math.abs(n)
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

interface StatCardProps {
  label: string
  ticker: string
  price: number | null
  color: string
  loading?: boolean
  /** 24h / 7d / 30d / 90d performance — rendered as a row of chips. */
  performance?: {
    change24h: number | null
    change7d: number | null
    change30d: number | null
    change90d: number | null
  }
  /** Optional market-cap rank chip rendered next to the ticker.
   *  Includes the next-rank delta so users see at a glance how much
   *  the asset has to move to overtake / be overtaken. Click-through
   *  to /stats for the full leaderboard. */
  rank?: {
    rank: number
    /** Symbol of the coin one position above (smaller rank #) — the
     *  next coin to overtake. null when this asset is #1. */
    nextSymbol: string | null
    /** Price delta needed to overtake nextSymbol (positive). */
    deltaToNextPrice: number | null
    deltaToNextPct: number | null
  }
  /** Optional metadata chip row rendered between price and perf chips:
   *  current market cap, % shielded supply, and 7D/30D mcap perf. All
   *  fields are optional — chips simply omit themselves when null, so
   *  the row degrades cleanly during partial-data loads.
   *
   *  Tri-state semantics:
   *   - `undefined`: meta isn't applicable to this card; hide the row.
   *   - `null`:      data is loading; render skeleton chips so the
   *                  layout doesn't reflow when chips appear.
   *   - object:      render real chips. */
  meta?: {
    marketCap: number | null
    shieldedPct: number | null
    mcapChange7d: number | null
    mcapChange30d: number | null
  } | null
}

export function StatCard({
  label,
  ticker,
  price,
  color,
  loading,
  performance,
  rank,
  meta,
}: StatCardProps) {
  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card p-3 flex flex-col gap-2 animate-pulse">
        <div className="h-4 w-24 rounded bg-muted" />
        <div className="h-7 w-32 rounded bg-muted" />
        <div className="h-4 w-20 rounded bg-muted" />
      </div>
    )
  }

  return (
    <div
      className="rounded-lg border bg-card p-3 flex flex-col gap-1"
      style={{ borderColor: `${color}44` }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="h-2 w-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
          {ticker}
        </span>
        <span className="text-xs text-muted-foreground">{label}</span>
        {/* Rank chip — sky-blue tinted (matches the treasury chip on the
            CYPH tile), small enough to tuck inline with the ticker. */}
        {rank && (
          <Link
            href="/stats"
            className="ml-auto group flex items-center gap-1 px-1.5 py-0.5 rounded border border-sky-500/30 bg-sky-500/[.08] hover:bg-sky-500/[.16] hover:border-sky-500/60 text-sky-300 transition-colors text-[10px] font-mono"
            title={
              rank.nextSymbol && rank.deltaToNextPrice != null
                ? `Rank #${rank.rank} · needs +$${Math.abs(rank.deltaToNextPrice).toFixed(2)} (${rank.deltaToNextPct?.toFixed(1) ?? "—"}%) to flip ${rank.nextSymbol}`
                : `Rank #${rank.rank}`
            }
          >
            <span className="font-semibold">#{rank.rank}</span>
            {rank.nextSymbol && rank.deltaToNextPrice != null && (
              <span className="opacity-90">
                +${Math.abs(rank.deltaToNextPrice).toFixed(0)} → {rank.nextSymbol}
              </span>
            )}
          </Link>
        )}
      </div>

      <p className="text-2xl font-mono font-bold text-foreground">
        {price != null
          ? price < 1
            ? `$${price.toFixed(4)}`
            : `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : "—"}
      </p>

      {/* Meta chip row — market cap, shielded %, and mcap-perf chips.
          Sits above the price-perf row so the chip stack reads
          fundamentals → momentum → recent move top-to-bottom. */}
      {meta === null ? (
        <div
          className="flex flex-wrap gap-1.5 pt-1"
          aria-label="Loading market metadata"
        >
          <span className="h-[18px] w-20 rounded border border-border bg-muted/30 animate-pulse" />
          <span className="h-[18px] w-24 rounded border border-emerald-500/20 bg-emerald-500/[.04] animate-pulse" />
          <span className="h-[18px] w-20 rounded border border-border/50 bg-muted/20 animate-pulse" />
          <span className="h-[18px] w-20 rounded border border-border/50 bg-muted/20 animate-pulse" />
        </div>
      ) : meta ? (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {meta.marketCap != null && fmtCompactUSD(meta.marketCap) && (
            <span
              className="px-1.5 py-0.5 rounded border border-border bg-muted/30 text-foreground text-[10px] font-mono whitespace-nowrap"
              title={`Market cap: $${meta.marketCap.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
            >
              {fmtCompactUSD(meta.marketCap)}
              <span className="text-muted-foreground"> mcap</span>
            </span>
          )}
          {meta.shieldedPct != null && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/[.07] text-emerald-300 text-[10px] font-mono whitespace-nowrap"
              title={`${meta.shieldedPct.toFixed(2)}% of circulating supply is in the shielded pools`}
            >
              <span aria-hidden="true">🛡️</span>
              {meta.shieldedPct.toFixed(1)}%
            </span>
          )}
          {/* Tighter labels — the surrounding context (price tile + perf
              chip row right below) is enough to telegraph "mcap perf",
              so the chip itself can drop "Mcap " and use a small "mc"
              suffix. Saves a line on narrow phones. */}
          <PerfChip label="7D mc" pct={meta.mcapChange7d ?? null} />
          <PerfChip label="30D mc" pct={meta.mcapChange30d ?? null} />
        </div>
      ) : null}

      {performance && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          <PerfChip label="24h" pct={performance.change24h} />
          <PerfChip label="7D" pct={performance.change7d} />
          <PerfChip label="30D" pct={performance.change30d} />
          <PerfChip label="90D" pct={performance.change90d} />
        </div>
      )}
    </div>
  )
}
