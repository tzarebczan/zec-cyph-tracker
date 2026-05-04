"use client"

import useSWR from "swr"
import { TrendingUp, TrendingDown, Moon, Sun, Clock, AlertCircle, RefreshCw } from "lucide-react"

class QuoteFetchError extends Error {
  status: number
  retryAfterSec?: number
  constructor(message: string, status: number, retryAfterSec?: number) {
    super(message)
    this.status = status
    this.retryAfterSec = retryAfterSec
  }
}

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const json = await res.json()
  if (!res.ok || (json && typeof json === "object" && "error" in json)) {
    throw new QuoteFetchError(
      json?.error ?? `Request failed: ${res.status}`,
      res.status,
      json?.retryAfterSec
    )
  }
  return json
}

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
  overnightMarketPrice: number | null
  overnightMarketChange: number | null
  overnightMarketChangePercent: number | null
  overnightMarketTime: number | null
  /** Server-side cache metadata (set by /api/quote when serving cached data) */
  _stale?: boolean
  _ageSec?: number
  _source?: string
}

interface Props {
  /** Controlled: whether extended-hours display is enabled */
  showExtended: boolean
  onToggle: () => void
  /** Optional layout className — parent controls grid sizing (e.g. "md:col-span-2") */
  className?: string
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

  if (state === "PRE") {
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

  // OVERNIGHT = Blue Ocean ATS session (8 PM – 4 AM ET, Sun–Thu). Unlocked by
  // the v7 quote `overnightPrice=true` flag (or scraped from the page).
  if (state === "OVERNIGHT" && q.overnightMarketPrice != null) {
    return {
      label: "Overnight · Blue Ocean ATS",
      badge: "OVERNIGHT",
      badgeClass: "bg-indigo-500/20 text-indigo-300 border-indigo-500/40",
      icon: <Moon className="h-3 w-3" />,
      livePrice: q.overnightMarketPrice,
      liveChange: q.overnightMarketChange,
      liveChangePct: q.overnightMarketChangePercent,
      liveTime: q.overnightMarketTime,
      isExtended: true,
    }
  }

  // PREPRE = the gap between yesterday's overnight close and today's pre-market.
  // Show whichever extended-hours print is freshest (overnight beats post).
  if (state === "PREPRE") {
    if (q.overnightMarketPrice != null) {
      return {
        label: "Last Overnight · Blue Ocean ATS",
        badge: "OVERNIGHT",
        badgeClass: "bg-indigo-500/20 text-indigo-300 border-indigo-500/40",
        icon: <Moon className="h-3 w-3" />,
        livePrice: q.overnightMarketPrice,
        liveChange: q.overnightMarketChange,
        liveChangePct: q.overnightMarketChangePercent,
        liveTime: q.overnightMarketTime,
        isExtended: true,
      }
    }
    return {
      label: "Closed · Last Post",
      badge: "CLOSED",
      badgeClass: "bg-muted text-muted-foreground border-border",
      icon: <Moon className="h-3 w-3" />,
      livePrice: q.postMarketPrice,
      liveChange: q.postMarketChange,
      liveChangePct: q.postMarketChangePercent,
      liveTime: q.postMarketTime,
      isExtended: true,
    }
  }

  if (state === "POST" || state === "POSTPOST") {
    // After 8 PM Yahoo flips POST → OVERNIGHT once Blue Ocean opens; until
    // then prefer the post-market price but surface overnight if it arrives.
    if (state === "POSTPOST" && q.overnightMarketPrice != null) {
      return {
        label: "Overnight · Blue Ocean ATS",
        badge: "OVERNIGHT",
        badgeClass: "bg-indigo-500/20 text-indigo-300 border-indigo-500/40",
        icon: <Moon className="h-3 w-3" />,
        livePrice: q.overnightMarketPrice,
        liveChange: q.overnightMarketChange,
        liveChangePct: q.overnightMarketChangePercent,
        liveTime: q.overnightMarketTime,
        isExtended: true,
      }
    }
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

export function CyphExtendedQuote({ showExtended, onToggle, className = "" }: Props) {
  const { data, error, isLoading, mutate } = useSWR<QuoteData>("/api/quote", fetcher, {
    // Server-side cache TTL is 30 s; polling much faster than that just
    // wastes round-trips. 30 s also matches Yahoo's underlying tick cadence.
    refreshInterval: 30_000,
    shouldRetryOnError: true,
    // If the server sent 429/503, back off for the retryAfter window before retrying.
    errorRetryInterval: 60_000,
    errorRetryCount: 5,
    onErrorRetry: (err, _key, _config, revalidate, { retryCount }) => {
      const e = err as QuoteFetchError
      const wait = (e?.retryAfterSec ?? 30) * 1000
      setTimeout(() => revalidate({ retryCount }), wait)
    },
  })

  const cardClass = `rounded-lg border bg-card p-4 flex flex-col gap-2 ${className}`
  const cardStyle = { borderColor: `${CYPH_COLOR}44` }

  if (isLoading && !data) {
    return (
      <div className={`${cardClass} animate-pulse`} style={cardStyle}>
        <div className="h-3 w-28 rounded bg-muted" />
        <div className="h-8 w-36 rounded bg-muted" />
        <div className="h-3 w-24 rounded bg-muted" />
      </div>
    )
  }

  if (error || !data || data.regularMarketPrice == null) {
    return (
      <div className={cardClass} style={cardStyle}>
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: CYPH_COLOR }}
          />
          <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            $CYPH
          </span>
        </div>
        <div className="flex items-start gap-2 text-xs font-mono text-destructive-foreground">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5 text-destructive" />
          <div className="flex flex-col gap-1">
            <span>Live quote unavailable — Yahoo Finance may be rate-limiting requests.</span>
            <button
              onClick={() => mutate()}
              className="self-start flex items-center gap-1.5 px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          </div>
        </div>
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
    <div className={cardClass} style={cardStyle}>
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

          {/* Stale-data indicator: shows when /api/quote is serving cached data
              because Yahoo is rate-limiting upstream. */}
          {data._stale && (
            <span
              className="flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono text-amber-400 border-amber-500/40 bg-amber-500/10"
              title={`Serving cached quote (~${data._ageSec ?? "?"}s old) — Yahoo may be rate-limiting.`}
            >
              <Clock className="h-3 w-3" />
              Cached
            </span>
          )}
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
