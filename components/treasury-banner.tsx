"use client"

import useSWR from "swr"
import Link from "next/link"
import { Landmark } from "lucide-react"

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const json = await res.json()
  if (!res.ok || (json && typeof json === "object" && "error" in json)) {
    throw new Error(json?.error ?? `Request failed: ${res.status}`)
  }
  return json
}

interface HoldingsResponse {
  summary: {
    totalZec: number
    totalCostUSD: number
    avgCostPerZec: number | null
    transactionCount: number
    lastTransactionAt: string | null
  }
}

function fmtCount(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 })
}

function fmtUSD(n: number) {
  if (Math.abs(n) >= 1_000_000)
    return `$${(n / 1_000_000).toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}M`
  if (Math.abs(n) >= 1000)
    return `$${(n / 1000).toLocaleString("en-US", {
      maximumFractionDigits: 1,
    })}k`
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

function fmtDate(iso: string | null) {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "2-digit",
  })
}

const ZEC_COLOR = "#fb923c"

/**
 * Compact one-row card showing CYPH's ZEC treasury at a glance:
 * holdings · cost basis · average cost · transaction count · last buy.
 * Full breakdown lives at /holdings.
 *
 * Self-hides on upstream failure so the dashboard never gains a broken
 * card — at worst the banner just doesn't render.
 */
export function TreasuryBanner() {
  const { data, error } = useSWR<HoldingsResponse>(
    "/api/cypherpunk-holdings",
    fetcher,
    {
      // Upstream changes a few times per quarter; refresh once an hour
      // is plenty. CF edge already caches the proxy response for 6h.
      refreshInterval: 60 * 60_000,
      revalidateOnFocus: false,
      keepPreviousData: true,
    }
  )

  if (error || !data?.summary) return null
  const s = data.summary
  if (s.totalZec <= 0) return null

  return (
    <Link
      href="/holdings"
      className="group rounded-lg border bg-card hover:bg-card/80 transition-colors px-3 py-2 flex items-center gap-3 text-xs font-mono"
      style={{ borderColor: `${ZEC_COLOR}33` }}
    >
      <Landmark
        className="h-4 w-4 flex-shrink-0"
        style={{ color: ZEC_COLOR }}
      />
      <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="text-muted-foreground uppercase tracking-wider text-[10px]">
          CYPH Treasury
        </span>
        <span className="text-foreground font-bold">
          {fmtCount(s.totalZec)} <span style={{ color: ZEC_COLOR }}>ZEC</span>
        </span>
        {s.avgCostPerZec != null && (
          <span className="text-muted-foreground">
            avg{" "}
            <span className="text-foreground/80">
              ${s.avgCostPerZec.toFixed(0)}
            </span>
          </span>
        )}
        <span className="text-muted-foreground hidden sm:inline">
          cost{" "}
          <span className="text-foreground/80">
            {fmtUSD(s.totalCostUSD)}
          </span>
        </span>
        <span className="text-muted-foreground hidden sm:inline">
          {s.transactionCount} tx
        </span>
        {s.lastTransactionAt && (
          <span className="text-muted-foreground hidden md:inline">
            last {fmtDate(s.lastTransactionAt)}
          </span>
        )}
      </div>
      <span
        className="text-muted-foreground group-hover:text-foreground group-hover:translate-x-0.5 transition-all flex-shrink-0"
        aria-hidden="true"
      >
        &rarr;
      </span>
    </Link>
  )
}
