"use client"

import useSWR from "swr"
import { TrendingUp, TrendingDown, Moon, Sun, Clock } from "lucide-react"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

interface QuoteData {
  symbol: string
  shortName: string
  currency: string
  marketState: string
  regularMarketPrice: number | null
  regularMarketChange: number | null
  regularMarketChangePercent: number | null
  regularMarketPreviousClose: number | null
  regularMarketTime: number | null
  preMarketPrice: number | null
  preMarketChange: number | null
  preMarketChangePercent: number | null
  preMarketTime: number | null
  postMarketPrice: number | null
  postMarketChange: number | null
  postMarketChangePercent: number | null
  postMarketTime: number | null
}

interface Props {
  /** Controlled: whether extended-hours display is enabled */
  showExtended: boolean
  onToggle: () => void
}

const CYPH_COLOR = "#34d399"

function fmtPrice(p: number | null) {
  if (p == null) return "—"
  return p < 1
    ? `$${p.toFixed(4)}`
    : `$${p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtTime(unixSec: number | null) {
  if (!unixSec) return null
  return new Date(unixSec * 1000).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })
}

type MarketSessionInfo = {
  label: string
  badge: string
  badgeClass: string
  icon: React.ReactNode
  /** The "live" price to show when extended is on */
  livePrice: number | null
  liveChange: number | null
  liveChangePct: number | null
  liveTime: number | null
  isExtended: boolean
}

function getSessionInfo(q: QuoteData): MarketSessionInfo {
  const state = q.marketState

  if (state === "REGULAR") {
    return {
      label: "Market Open",
      badge: "LIVE",
      badgeClass: "bg-green-500/20 text-green-400 border-green-500/40",
      icon: <Sun className="h-3 w-3" />,
      livePrice: q.regularMarketPrice,
      liveChange: q.regularMarketChange,
      liveChangePct: q.regularMarketChangePercent,
      liveTime: q.regularMarketTime,
      isExtended: false,
    }
  }

  if (state === "PRE" || state === "PREPRE") {
    return {
      label: "Pre-Market",
      badge: "PRE",
      badgeClass: "bg-amber-500/20 text-amber-400 border-amber-500/40",
      icon: <Moon className="h-3 w-3" />,
      livePrice: q.preMarketPrice,
      liveChange: q.preMarketChange,
      liveChangePct: q.preMarketChangePercent,
      liveTime: q.preMarketTime,
      isExtended: true,
    }
  }

  if (state === "POST" || state === "POSTPOST") {
    return {
      label: "After Hours",
      badge: "AH",
      badgeClass: "bg-violet-500/20 text-violet-400 border-violet-500/40",
      icon: <Moon className="h-3 w-3" />,
      livePrice: q.postMarketPrice,
      liveChange: q.postMarketChange,
      liveChangePct: q.postMarketChangePercent,
      liveTime: q.postMarketTime,
      isExtended: true,
    }
  }

  // CLOSED
  return {
    label: "Market Closed",
    badge: "CLOSED",
    badgeClass: "bg-muted text-muted-foreground border-border",
    icon: <Clock className="h-3 w-3" />,
    livePrice: null,
    liveChange: null,
    liveChangePct: null,
    liveTime: null,
    isExtended: false,
  }
}

export function CyphExtendedQuote({ showExtended, onToggle }: Props) {
  const { data, isLoading } = useSWR<QuoteData>("/api/quote", fetcher, {
    refreshInterval: 15_000,
  })

  if (isLoading || !data || "error" in data) {
    return (
      <div
        className="rounded-lg border bg-card p-4 flex flex-col gap-2 col-span-2 animate-pulse"
        style={{ borderColor: `${CYPH_COLOR}44` }}
      >
        <div className="h-3 w-28 rounded bg-muted" />
        <div className="h-8 w-36 rounded bg-muted" />
        <div className="h-3 w-24 rounded bg-muted" />
      </div>
    )
  }

  const session = getSessionInfo(data)

  // Decide what price to display as the headline
  const displayExtended = showExtended && session.isExtended && session.livePrice != null
  const headlinePrice = displayExtended ? session.livePrice : data.regularMarketPrice
  const headlineChange = displayExtended ? session.liveChange : data.regularMarketChange
  const headlineChangePct = displayExtended ? session.liveChangePct : data.regularMarketChangePercent
  const isPositive = (headlineChangePct ?? 0) >= 0
  const liveTime = fmtTime(session.liveTime ?? data.regularMarketTime)

  return (
    <div
      className="rounded-lg border bg-card p-4 flex flex-col gap-2 col-span-2"
      style={{ borderColor: `${CYPH_COLOR}44` }}
    >
      {/* Top row: ticker + session badge + toggle */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="h-2 w-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: CYPH_COLOR }}
          />
          <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            $CYPH
          </span>
          <span className="text-xs text-muted-foreground truncate hidden sm:block">
            Cypherpunk Holdings · NASDAQ
          </span>

          {/* Session badge */}
          <span
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono font-semibold ${session.badgeClass}`}
          >
            {session.icon}
            {session.badge}
          </span>
          <span className="text-[10px] font-mono text-muted-foreground hidden sm:block">
            {session.label}
          </span>
        </div>

        {/* Extended-hours toggle */}
        <button
          onClick={onToggle}
          className={`flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] font-mono transition-colors ${
            showExtended
              ? "border-primary/50 bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:text-foreground"
          }`}
          aria-pressed={showExtended}
          title={showExtended ? "Extended hours ON — click to disable" : "Extended hours OFF — click to enable"}
        >
          <Moon className="h-3 w-3" />
          Ext. Hours
        </button>
      </div>

      {/* Main price */}
      <div className="flex items-end gap-3 flex-wrap">
        <p className="text-2xl font-mono font-bold text-foreground leading-none">
          {fmtPrice(headlinePrice)}
        </p>
        {headlineChangePct != null && (
          <div
            className={`flex items-center gap-1 text-xs font-mono pb-0.5 ${
              isPositive ? "text-green-400" : "text-red-400"
            }`}
          >
            {isPositive ? (
              <TrendingUp className="h-3 w-3" />
            ) : (
              <TrendingDown className="h-3 w-3" />
            )}
            {isPositive ? "+" : ""}
            {headlineChange != null ? fmtPrice(headlineChange).replace("$", "") : ""}
            {"  "}({isPositive ? "+" : ""}
            {headlineChangePct.toFixed(2)}%)
          </div>
        )}
        {liveTime && (
          <span className="text-[10px] font-mono text-muted-foreground pb-0.5">
            as of {liveTime}
          </span>
        )}
      </div>

      {/* Extended-hours annotation + last close */}
      {displayExtended && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-muted-foreground border-t border-border/50 pt-2 mt-1">
          <span>
            {session.label} price
            {" · "}
            <span className="text-amber-400/80">outside regular trading hours</span>
          </span>
          {data.regularMarketPreviousClose != null && (
            <span>
              Last close:{" "}
              <span className="text-foreground/70">
                {fmtPrice(data.regularMarketPreviousClose)}
              </span>
            </span>
          )}
        </div>
      )}

      {/* When NOT showing extended, show prev close as secondary info */}
      {!displayExtended && session.isExtended && data.regularMarketPreviousClose != null && (
        <div className="text-[10px] font-mono text-muted-foreground">
          Last close:{" "}
          <span className="text-foreground/70">
            {fmtPrice(data.regularMarketPreviousClose)}
          </span>
          {" · "}
          <span className="text-amber-400/70">{session.label} available</span>
        </div>
      )}

      {/* Always show prev close during regular / closed when no extended */}
      {!session.isExtended && data.regularMarketPreviousClose != null && (
        <div className="text-[10px] font-mono text-muted-foreground">
          Prev close:{" "}
          <span className="text-foreground/70">
            {fmtPrice(data.regularMarketPreviousClose)}
          </span>
        </div>
      )}
    </div>
  )
}
