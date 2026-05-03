"use client"

import { TrendingUp, TrendingDown } from "lucide-react"

interface StatCardProps {
  label: string
  ticker: string
  price: number | null
  change24h: number | null
  color: string
  loading?: boolean
}

export function StatCard({
  label,
  ticker,
  price,
  change24h,
  color,
  loading,
}: StatCardProps) {
  const isPositive = (change24h ?? 0) >= 0

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2 animate-pulse">
        <div className="h-4 w-24 rounded bg-muted" />
        <div className="h-7 w-32 rounded bg-muted" />
        <div className="h-4 w-20 rounded bg-muted" />
      </div>
    )
  }

  return (
    <div
      className="rounded-lg border bg-card p-4 flex flex-col gap-1"
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
    </div>
  )
}
