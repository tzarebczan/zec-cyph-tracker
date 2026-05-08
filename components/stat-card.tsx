"use client"

import Link from "next/link"
import { PerfChip } from "@/components/perf-chip"

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
}

export function StatCard({
  label,
  ticker,
  price,
  color,
  loading,
  performance,
  rank,
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
