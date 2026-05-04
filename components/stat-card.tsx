"use client"

import { TrendingUp, TrendingDown } from "lucide-react"
import { PerfChip } from "@/components/perf-chip"

interface StatCardProps {
  label: string
  ticker: string
  price: number | null
  change24h: number | null
  color: string
  loading?: boolean
  /** Optional 7/30/90-day performance — rendered as a row of chips. */
  performance?: {
    change7d: number | null
    change30d: number | null
    change90d: number | null
  }
}

export function StatCard({
  label,
  ticker,
  price,
  change24h,
  color,
  loading,
  performance,
}: StatCardProps) {
  const isPositive = (change24h ?? 0) >= 0

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
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
          {ticker}
        </span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>

      <p className="text-2xl font-mono font-bold text-foreground">
        {price != null
          ? price < 1
            ? `$${price.toFixed(4)}`
            : `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : "—"}
      </p>

      {change24h != null && (
        <div
          className={`flex items-center gap-1 text-xs font-mono ${
            isPositive ? "text-green-400" : "text-red-400"
          }`}
        >
          {isPositive ? (
            <TrendingUp className="h-3 w-3" />
          ) : (
            <TrendingDown className="h-3 w-3" />
          )}
          <span>
            {isPositive ? "+" : ""}
            {change24h.toFixed(2)}% 24h
          </span>
        </div>
      )}

      {performance && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          <PerfChip label="7D" pct={performance.change7d} />
          <PerfChip label="30D" pct={performance.change30d} />
          <PerfChip label="90D" pct={performance.change90d} />
        </div>
      )}
    </div>
  )
}
