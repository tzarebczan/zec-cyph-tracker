"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { usePageVisible } from "@/hooks/use-page-visible"
import { usePersistentState } from "@/lib/use-persistent-state"
import {
  CoinLogo,
  CornerBox,
  BlockProgress,
  InfoTip,
  PhosphorSpark,
  LiveNumber,
  PerfGrid,
  MultiLineChartE,
  Skeleton,
  useIsMobile,
  ETabs,
} from "./primitives"
import { PipPopout, PwaInstall } from "./footer-buttons"
import { paletteVar, withAlpha, E_STATIC } from "./theme"
import {
  comparePricesResponse,
  compareQuoteSnapshot,
  fmtCompactUSD,
  fmtEtClock,
  fmtUSD,
  swrFetcher,
} from "./format"
import { pickLiveCyph, pickLiveCyphSession } from "./quote-utils"
import { computeCyphNav } from "./cyph-nav"
import { IronwoodBanner, IronwoodTotalsPill } from "./ironwood"
import { DepthSection, DepthStrip } from "./order-depth"
import { DEPTH_STATS_VIEW } from "./zec-views"
import { MiningChip } from "./cyph-mining"
import { SessionClock, useMarketSession } from "./market-clock"
import { CyphDepthStrip } from "./cyph-depth"
import {
  computePortfolioMetrics,
  hasPortfolioData,
  previousCloseFromHistory,
  usePortfolioState,
  PORTFOLIO_HISTORY_KEY,
} from "./portfolio-state"
import {
  sanitizeDashboardTiles,
  useCyphzecSettings,
  type DashboardTileKey,
} from "./use-cyphzec-settings"
import type {
  CypherpunkMnavResponse,
  PricesResponse,
  QuoteSnapshot,
  MarketsResponse,
  ZecStatsResponse,
  HoldingsResponse,
  CyphVolumeResponse,
  ZecExchangesResponse,
} from "./api-types"

// Period labels follow finance-pricing convention: weeks/months/years
// rather than raw days so a 30-day chart reads as "1M". The query-param
// value (left side of the tuple) stays in days because that's what
// /api/prices already accepts. Exported so app/page.tsx can render
// the period selector in EShell's headerExtra slot.
export const PERIODS = [
  ["1", "1D"],
  ["7", "1W"],
  ["14", "2W"],
  ["30", "1M"],
  ["90", "3M"],
  ["180", "6M"],
  ["all", "ALL"],
] as const

export type Period = (typeof PERIODS)[number][0]
const VALID_PERIODS = new Set(PERIODS.map(([v]) => v))
export function isValidPeriod(v: unknown): v is Period {
  return typeof v === "string" && VALID_PERIODS.has(v as Period)
}

// Keep in step with the same map in components/stats.tsx.
const POOL_COLORS = {
  ironwood: "#f6c945",
  orchard: "#7dd3fc",
  sapling: "#67e8f9",
  sprout: "#22d3ee",
  lockbox: "#a78bfa",
} as const

/** Shared chrome for tile meta-chips (OPEN / #rank / LIVE / Ironwood /
 *  CYPH·BTC). ~18px tall — snug to the 11px title label, same 9px type,
 *  minimal vertical pad (was h-6 / 24px and read as oversized). */
const TILE_CHIP =
  "box-border inline-flex h-[18px] min-h-[18px] max-h-[18px] shrink-0 items-center justify-center gap-1 border px-1.5 py-0 text-[9px] font-bold leading-none tracking-[0.1em]"
/** Clickable meta-chip — same box as TILE_CHIP + Ironwood-style hover. */
const TILE_CHIP_LINK =
  `${TILE_CHIP} transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1`
/** Tile title label — keeps CYPH / ZEC / CYPH/ZEC / PORT aligned. */
const TILE_TITLE =
  "text-[11px] font-bold tracking-[0.28em] leading-none shrink-0"

// Stable empty-array sentinel for history. Used by the `useMemo` that
// projects `prices?.history ?? []` so the fallback `[]` is the same
// reference across renders before the first /api/prices response —
// keeps downstream useMemos (chartData, sparklines, ratioStats) from
// invalidating purely because they got a fresh empty array each tick.
const EMPTY_HISTORY: PricesResponse["history"] = []
const FRESH_REGULAR_TICK_MS = 20 * 60 * 1000
const HOLIDAY_TICK_THRESHOLD_MS = 4 * 60 * 60 * 1000

function isRegularTradingWindowEt(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value
  const weekday = get("weekday")
  if (weekday === "Sat" || weekday === "Sun") return false
  const hour = Number(get("hour"))
  const minute = Number(get("minute"))
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false
  const minutes = (hour % 24) * 60 + minute
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60
}

function withLiveTail(
  history: PricesResponse["history"],
  live: { cyph: number | null; zec: number | null; btc: number | null }
): PricesResponse["history"] {
  const last = history[history.length - 1]
  const zec =
    live.zec != null && Number.isFinite(live.zec) ? live.zec : last?.zec ?? null
  if (zec == null || !Number.isFinite(zec)) return history

  const cyph =
    live.cyph != null && Number.isFinite(live.cyph)
      ? live.cyph
      : last?.cyph ?? null
  const btc =
    live.btc != null && Number.isFinite(live.btc) ? live.btc : last?.btc ?? null
  const ratio = cyph != null && zec > 0 ? cyph / zec : null
  const zecBtcRatio = btc != null && btc > 0 ? zec / btc : null

  if (
    last &&
    last.cyph === cyph &&
    last.zec === zec &&
    last.btc === btc &&
    last.ratio === ratio &&
    last.zecBtcRatio === zecBtcRatio
  ) {
    return history
  }

  return [
    ...history,
    {
      timestamp: Date.now(),
      date: "LIVE",
      cyph,
      btc,
      zec,
      ratio,
      zecBtcRatio,
    },
  ]
}

function previousFromPct(
  price: number | null | undefined,
  pct: number | null | undefined
): number | null {
  if (price == null || pct == null || !Number.isFinite(price) || !Number.isFinite(pct)) {
    return null
  }
  const divisor = 1 + pct / 100
  return divisor > 0 ? price / divisor : null
}

function changeFromPreviousClose(
  price: number | null | undefined,
  previousClose: number | null | undefined
): { dollars: number; pct: number } | null {
  if (
    price == null ||
    previousClose == null ||
    !Number.isFinite(price) ||
    !Number.isFinite(previousClose) ||
    previousClose <= 0
  ) {
    return null
  }
  const dollars = price - previousClose
  return { dollars, pct: (dollars / previousClose) * 100 }
}

function fmtSignedUSDLocal(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--"
  return `${value >= 0 ? "+" : "-"}${fmtUSD(Math.abs(value))}`
}

function fmtSignedPctLocal(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--"
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`
}

function signedColor(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return paletteVar("text")
  return value >= 0 ? paletteVar("cyph") : E_STATIC.red
}
type RatioMode = "cyphZec" | "btcZec"

// Tiny terminal-style icons. Inline SVG (rather than emoji) renders
// identically across iOS/Android/desktop and inherits `currentColor`
// so they tint with whatever palette / active state the parent uses.
// All share a 16-unit viewBox so the `size` prop produces predictable
// pixel dimensions in any context.

function ShieldIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className="shrink-0 inline-block"
    >
      <path d="M8 1L2 3v4.5c0 3.5 2.4 6.6 6 7.5 3.6-.9 6-4 6-7.5V3L8 1zm0 2.1l4 1.3v3.1c0 2.6-1.7 4.9-4 5.6-2.3-.7-4-3-4-5.6V4.4l4-1.3z" />
    </svg>
  )
}

/** Stacked bars — used for VOLUME metric cells. */
function BarsIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className="shrink-0 inline-block"
    >
      <rect x="1" y="9" width="3" height="6" />
      <rect x="6.5" y="5" width="3" height="10" />
      <rect x="12" y="1" width="3" height="14" />
    </svg>
  )
}

/** Activity line — used for TRANSACTIONS metric cells. */
function ActivityIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="square"
      strokeLinejoin="miter"
      className="shrink-0 inline-block"
    >
      <path d="M1 9 L4 9 L6 4 L9 12 L11 7 L15 7" />
    </svg>
  )
}

/** Pickaxe-ish wedge — used for MINED progress cells. */
function MinedIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className="shrink-0 inline-block"
    >
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 2a5 5 0 0 1 5 5h-5V3z" />
    </svg>
  )
}

/** Vault — used for TREASURY metric cells. */
function VaultIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      className="shrink-0 inline-block"
    >
      <rect x="1.5" y="2.5" width="13" height="11" />
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 5.5v2M8 8.5v2M5.5 8h2M8.5 8h2" />
    </svg>
  )
}

export function Dashboard({ period }: { period: Period }) {
  const pageVisible = usePageVisible()
  const pollPaused = () => !pageVisible
  // The period selector lives in EShell's `headerExtra` slot
  // (rendered from app/page.tsx); Dashboard just consumes the
  // current value to drive the /api/prices fetch.
  const [ratioMode, setRatioMode] = usePersistentState<RatioMode>(
    "cyphzec.ratio.mode",
    "cyphZec",
    (v): v is RatioMode => v === "cyphZec" || v === "btcZec"
  )
  const [settings, setSetting] = useCyphzecSettings()
  const dashboardTilePrefs = sanitizeDashboardTiles(settings.dashboardTiles)
  const [portfolio, , , portfolioHydrated] = usePortfolioState()
  // Chart-local period override. The chart defaults to the global page
  // period, but users can pin it to a different window. We persist only
  // the override value (null means "follow global"), so the main site
  // selector keeps working unless the user explicitly overrides.
  const [chartPeriodOverride, setChartPeriodOverride] =
    usePersistentState<Period | null>(
      "cyphzec.chart.period.override",
      null,
      (v): v is Period | null => v === null || isValidPeriod(v)
    )
  const chartPeriod = chartPeriodOverride ?? period
  // Main prices feed drives the dashboard tiles, right-panel stats, and
  // sparklines. It follows the global period selector.
  const { data: prices } = useSWR<PricesResponse>(
    `/api/prices?days=${period}`,
    swrFetcher,
    {
      refreshInterval: 60_000,
      isPaused: pollPaused,
      compare: comparePricesResponse,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    }
  )
  // Separate feed for the overlay chart so its local period selector
  // doesn't affect the rest of the dashboard.
  const { data: chartPrices } = useSWR<PricesResponse>(
    `/api/prices?days=${chartPeriod}`,
    swrFetcher,
    {
      refreshInterval: 60_000,
      isPaused: pollPaused,
      compare: comparePricesResponse,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    }
  )
  // Always-on tick subscription so the headline ZEC price ticks even
  // when the user has the chart on a longer period.
  const { data: tick } = useSWR<PricesResponse>(
    "/api/prices?days=7",
    swrFetcher,
    {
      refreshInterval: 60_000,
      isPaused: pollPaused,
      compare: comparePricesResponse,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    }
  )
  // The portfolio tile's 7D / 30D / 90D readings must not depend on the chart
  // period: a window baseline is the newest candle at least N days old, so at
  // period=90 nothing was old enough for the 90D cell and it read "--". This is
  // the same feed /portfolio reads, so the two share one cache entry, and it is
  // only fetched for users who actually have holdings.
  const { data: portfolioPrices } = useSWR<PricesResponse>(
    hasPortfolioData(portfolio) ? PORTFOLIO_HISTORY_KEY : null,
    swrFetcher,
    {
      refreshInterval: 300_000,
      isPaused: pollPaused,
      compare: comparePricesResponse,
      keepPreviousData: true,
    }
  )
  const { data: quote } = useSWR<QuoteSnapshot>("/api/quote", swrFetcher, {
    refreshInterval: 30_000,
    isPaused: pollPaused,
    compare: compareQuoteSnapshot,
    revalidateOnFocus: true,
    keepPreviousData: true,
  })
  const { data: markets } = useSWR<MarketsResponse>("/api/markets", swrFetcher, {
    refreshInterval: 60_000,
    keepPreviousData: true,
  })
  const { data: zecStats } = useSWR<ZecStatsResponse>(
    "/api/zec-stats",
    swrFetcher,
    {
      refreshInterval: 5 * 60_000,
      revalidateOnFocus: true,
      keepPreviousData: true,
    }
  )
  // Treasury — slow-moving (purchases are weeks apart) so a 5-min
  // refresh and the API's own KV-cached 6h edge TTL are plenty.
  const { data: holdings } = useSWR<HoldingsResponse>(
    "/api/cypherpunk-holdings",
    swrFetcher,
    {
      refreshInterval: 5 * 60_000,
      keepPreviousData: true,
    }
  )
  const { data: cyphVolume } = useSWR<CyphVolumeResponse>(
    "/api/cyph-volume",
    swrFetcher,
    {
      refreshInterval: 60_000,
      keepPreviousData: true,
    }
  )
  // Official Cypherpunk mNAV feed drives the headline discount/premium.
  const { data: cypherpunkMnav } = useSWR<CypherpunkMnavResponse>(
    "/api/cypherpunk-mnav",
    swrFetcher,
    {
      refreshInterval: 5 * 60_000,
      keepPreviousData: true,
    }
  )
  // Daily ZEC tx counts — used in the ZEC tile's at-a-glance row.
  // Same SWR key as the stats page so the two surfaces share a
  // single network fetch per refresh window.
  const { data: txStats } = useSWR<{
    days: { date: string; total: number }[]
  }>("/api/zec-tx-stats", swrFetcher, {
    refreshInterval: 30 * 60_000,
    keepPreviousData: true,
  })
  const dailyZecTx = useMemo(() => {
    const days = txStats?.days ?? []
    return days.length > 0 ? days[days.length - 1].total : null
  }, [txStats])
  // Per-exchange ZEC volume distribution. Same SWR key as the /stats
  // EXCHANGES tab so a user landing on either surface shares the one
  // upstream call. CG's tickers feed updates ~once a minute server-side
  // so a 5-min client refresh is more than enough.
  const { data: zecExchanges } = useSWR<ZecExchangesResponse>(
    "/api/zec-exchanges",
    swrFetcher,
    {
      refreshInterval: 5 * 60_000,
      keepPreviousData: true,
    }
  )
  // Top-3 exchanges for the at-a-glance "TOP MARKETS" strip on the ZEC
  // tile. Filtered to non-zero volume (CG occasionally returns rows
  // with valid pairs but pending volume settlement) so blank chips
  // don't slip through.
  const topExchanges = useMemo(() => {
    return (zecExchanges?.byExchange ?? [])
      .filter((e) => e.volumeUsd24h > 0)
      .slice(0, 3)
  }, [zecExchanges])
  const zecVolume24h = useMemo(() => {
    const exchangeTotal = zecExchanges?.total24hVolumeUsd ?? 0
    if (exchangeTotal > 0) return exchangeTotal

    const summedExchangeVolume = (zecExchanges?.byExchange ?? []).reduce(
      (sum, exchange) =>
        sum +
        (Number.isFinite(exchange.volumeUsd24h) ? exchange.volumeUsd24h : 0),
      0
    )
    if (summedExchangeVolume > 0) return summedExchangeVolume

    const statsVolume = zecStats?.volume24h ?? 0
    return statsVolume > 0 ? statsVolume : null
  }, [zecExchanges, zecStats])

  const latestChartCyphTick = useMemo(() => {
    const points = prices?.history ?? EMPTY_HISTORY
    for (let i = points.length - 1; i >= 0; i -= 1) {
      const point = points[i]
      if (point.cyph != null && Number.isFinite(point.cyph)) {
        return { price: point.cyph, timestamp: point.timestamp }
      }
    }
    return null
  }, [prices?.history])
  const quoteRegularTickAgeMs =
    quote?.regularMarketTime != null
      ? Date.now() - quote.regularMarketTime * 1000
      : null
  const chartCyphTickAgeMs = latestChartCyphTick
    ? Date.now() - latestChartCyphTick.timestamp
    : null
  // Yahoo v7 can flip to REGULAR while still returning yesterday's close.
  // /api/prices uses the independent v8 candle path and is already polled by
  // this page, so prefer its fresh minute tick until the quote feed catches up.
  const usesChartCyphTick =
    isRegularTradingWindowEt() &&
    latestChartCyphTick != null &&
    chartCyphTickAgeMs != null &&
    chartCyphTickAgeMs >= -60_000 &&
    chartCyphTickAgeMs < FRESH_REGULAR_TICK_MS &&
    (quoteRegularTickAgeMs == null ||
      quoteRegularTickAgeMs >= FRESH_REGULAR_TICK_MS)
  const cachedCyphPrice =
    tick?.current?.cyph?.price ?? prices?.current?.cyph?.price ?? null
  const cyphPrice = usesChartCyphTick
    ? latestChartCyphTick.price
    : pickLiveCyph(quote) ?? cachedCyphPrice
  // Companion to `cyphPrice`: tells us *which* session (REGULAR/PRE/
  // POST/OVN) is driving the headline + the per-session change vs the
  // prior regular close. Drives the AH-aware second line on the CYPH
  // tile so users see the actual after-hours move (e.g. "AFT +$0.12 /
  // +1.5% vs close") rather than a misleading daily-candle 24h figure.
  const cyphSessionDetail = pickLiveCyphSession(quote)
  const zecPrice =
    tick?.current?.zec?.price ?? prices?.current?.zec?.price ?? null
  const btcPrice =
    tick?.current?.btc?.price ??
    prices?.current?.btc?.price ??
    markets?.coins.find((c) => c.symbol === "BTC")?.price ??
    null
  const ratio =
    cyphPrice != null && zecPrice != null && zecPrice > 0
      ? cyphPrice / zecPrice
      : null
  const zecBtcRatio =
    btcPrice != null && btcPrice > 0 && zecPrice != null
      ? zecPrice / btcPrice
      : null
  // Top-level BTC figures for the ZEC panel's Bitcoin block (mirrors a few
  // headline stats from the /bitcoin page; no extra fetch — all from the
  // markets + tick data the dashboard already loads).
  const btcCoin = markets?.coins.find((c) => c.symbol === "BTC") ?? null
  const zecCoin = markets?.coins.find((c) => c.symbol === "ZEC") ?? null
  // 24h change: prefer the markets leaderboard, which is CoinMarketCap-sourced
  // (CoinPaprika fallback) — so the headline 24h matches what users see on
  // coinmarketcap.com. The daily-candle figure from /api/prices walks Kraken
  // closes at 00:00 UTC and picks the last close before now-24h (24-48h ago),
  // which drifts from a true rolling 24h; keep it only as a fallback.
  const btcChange24h =
    btcCoin?.change24h ??
    tick?.current?.btc?.change24h ??
    prices?.current?.btc?.change24h ??
    null
  const btcMarketCap = btcCoin?.marketCap ?? null
  const btcMined =
    btcCoin?.circulatingSupply != null
      ? (btcCoin.circulatingSupply / 21e6) * 100
      : null
  const satsPerZec = zecBtcRatio != null ? zecBtcRatio * 1e8 : null
  const activeRatio = ratioMode === "btcZec" ? zecBtcRatio : ratio
  const activeRatioLabel = ratioMode === "btcZec" ? "ZEC/BTC" : "CYPH/ZEC"
  const activePrimaryLabel = ratioMode === "btcZec" ? "BTC" : "CYPH"
  const formatActiveRatio = (v: number) =>
    v < 0.001 ? v.toExponential(3) : v.toPrecision(4)

  // Use a stable empty-array sentinel when prices haven't landed yet
  // so downstream useMemos keyed on `history` don't invalidate every
  // render before the first /api/prices response.
  const history = useMemo(() => prices?.history ?? EMPTY_HISTORY, [prices])
  const liveHistory = useMemo(
    () =>
      withLiveTail(history, {
        cyph: cyphPrice,
        zec: zecPrice,
        btc: btcPrice,
      }),
    [history, cyphPrice, zecPrice, btcPrice]
  )
  const stats = prices?.stats
  const cyphHistoryPreviousClose = previousCloseFromHistory(history, "cyph")
  // A stock's displayed "today" move is current price vs the previous
  // completed regular close. `/api/prices` computes rolling/history-window
  // performance and can therefore use an older candle during the session.
  // Anchor every dashboard daily readout to the quote close instead. When the
  // fresher v8 chart tick is driving `cyphPrice`, this also updates the move
  // from that tick rather than leaving Yahoo's slightly older delta in place.
  // Close-to-close move of the last completed regular session. Yahoo's
  // regularMarketPrice / regularMarketPreviousClose pair expresses exactly
  // that in every session: during REGULAR the first is the live print and the
  // second is yesterday's close; during PRE/POST/OVN the first is the most
  // recent completed close and the second is the close before it. Either way
  // the delta spans one session, which is what a "24H" label should mean.
  //
  // Deliberately NOT anchored to cyphSessionDetail.prevClose. That field's job
  // is anchoring the extended-hours delta, so it holds *today's* close during
  // POST; pairing it with the live after-hours price made the 24H figure
  // report the after-hours move instead — +4.20% against a $1.19 close on a
  // day the session itself gained +11.21%.
  // `usesChartCyphTick` means the quote's regular tick has gone stale (>20min)
  // and the chart feed carries a fresher regular print, so prefer that as the
  // session's current value — otherwise this would quietly regress to a stale
  // numerator in exactly the case that fallback exists to cover.
  const cyphRegularNow = usesChartCyphTick
    ? cyphPrice
    : quote?.regularMarketPrice
  const cyphSessionMove = changeFromPreviousClose(
    cyphRegularNow,
    quote?.regularMarketPreviousClose
  )
  const cyphPreviousClose =
    quote?.regularMarketPreviousClose ??
    cyphSessionDetail.prevClose ??
    cyphHistoryPreviousClose
  const cyphChange24h =
    cyphSessionMove?.pct ??
    quote?.regularMarketChangePercent ??
    stats?.cyph.change24h ??
    prices?.current?.cyph.change24h ??
    null
  // Prefer the CMC-sourced markets leaderboard so the ZEC 24h matches
  // coinmarketcap.com. CoinGecko's /api/zec-stats figure (cached ~1h) and the
  // /api/prices daily-candle approximation both drift from CMC's rolling 24h.
  const zecChange24h =
    zecCoin?.change24h ??
    zecStats?.change24h ??
    stats?.zec.change24h ??
    prices?.current?.zec.change24h ??
    null
  // CYPH perf windows including extended hours. The server's stats are
  // computed against the last REGULAR close (Yahoo v8 regularMarketPrice,
  // surfaced as prices.current.cyph.price), so they miss the pre/after/
  // overnight move. Re-anchor each window to the live extended-hours price
  // (`cyphPrice`, which pickLiveCyph sources from pre/post/ovn) while keeping
  // the server's exact N-days-ago reference: since
  //   serverPct = (serverNow - refN) / refN
  // the implied refN is serverNow / (1 + serverPct/100), and the AH-inclusive
  // window is (cyphPrice - refN) / refN. During the regular session
  // cyphPrice == serverNow, so this returns the server value unchanged.
  const cyphServerNow = prices?.current?.cyph.price ?? null
  const extendCyphPerf = (serverPct: number | null | undefined): number | null => {
    if (serverPct == null) return null
    if (cyphPrice == null || cyphServerNow == null || cyphServerNow <= 0) {
      return serverPct
    }
    const denom = 1 + serverPct / 100
    if (Math.abs(denom) < 1e-9) return serverPct
    const refN = cyphServerNow / denom
    if (!(refN > 0)) return serverPct
    return ((cyphPrice - refN) / refN) * 100
  }
  const cyphPerf24 = cyphChange24h ?? extendCyphPerf(stats?.cyph.change24h)
  const cyphPerf7 = extendCyphPerf(stats?.cyph.change7d)
  const cyphPerf30 = extendCyphPerf(stats?.cyph.change30d)
  const cyphPerf90 = extendCyphPerf(stats?.cyph.change90d)
  const cyphRatioChange24h = cyphChange24h ?? cyphPerf24
  const cyphPortfolioPrice =
    quote?.marketState === "REGULAR"
      ? cyphPrice
      : quote?.regularMarketPrice ?? cyphSessionDetail.prevClose ?? cyphPrice
  const cyphPortfolioPreviousClose =
    quote?.regularMarketPreviousClose ??
    cyphHistoryPreviousClose ??
    previousFromPct(cyphPortfolioPrice, cyphChange24h)
  const zecPortfolioPreviousClose =
    previousCloseFromHistory(history, "zec") ??
    previousFromPct(zecPrice, zecChange24h)
  // Falls back to the period feed only until the 270-day one lands, so the
  // tile shows numbers on first paint rather than a row of dashes.
  const portfolioHistory = portfolioPrices?.history ?? history
  const portfolioMetrics = useMemo(
    () =>
      computePortfolioMetrics({
        state: portfolio,
        cyphPrice: cyphPortfolioPrice,
        zecPrice,
        cyphPreviousClose: cyphPortfolioPreviousClose,
        zecPreviousClose: zecPortfolioPreviousClose,
        history: portfolioHistory,
      }),
    [
      portfolio,
      cyphPortfolioPrice,
      zecPrice,
      cyphPortfolioPreviousClose,
      zecPortfolioPreviousClose,
      portfolioHistory,
    ]
  )
  const portfolioReady = portfolioHydrated && hasPortfolioData(portfolio)
  const portfolioLoading = !portfolioHydrated
  const dashboardTiles = useMemo(() => {
    const visible = dashboardTilePrefs.filter(
      (key) => key !== "portfolio" || portfolioReady
    )
    return visible.length > 0 ? visible : sanitizeDashboardTiles(null)
  }, [dashboardTilePrefs, portfolioReady])

  // 24H dollar change for the CYPH and ZEC headline tiles. The new
  // design adds a "+$0.00 today" row under the headline so the tile
  // surfaces the absolute move alongside the % change in the badge.
  //
  // ZEC: prefer the CoinGecko-sourced 24h change from /api/zec-stats
  // over the daily-candle approximation in /api/prices.stats. The
  // /api/prices fallback walks Kraken's daily candles (timestamped at
  // 00:00 UTC) with `priceNDaysAgo(1)` and picks the most recent
  // close strictly *before* `now - 24h`. With "now" mid-day, that's
  // yesterday's close — actually 24-48h ago — so the rendered "today"
  // delta was overstating the move (e.g. showing +$79 / +13% for a
  // real 24h move closer to +$30 / +5%). CG returns a clean rolling
  // 24h figure, so we use it as the primary and only fall back when
  // /api/zec-stats hasn't landed yet.
  // Dollar move of the same session as cyphChange24h, so the "+$X today
  // (+Y%)" pair can't describe two different windows. Falling back to
  // cyphSessionDetail.change would reintroduce the after-hours delta.
  const cyphDollarChange =
    cyphSessionMove?.dollars ??
    quote?.regularMarketChange ??
    (cyphPrice != null && cyphChange24h != null
      ? (cyphPrice * cyphChange24h) / (100 + cyphChange24h)
      : null)
  const zecDollarChange =
    zecPrice != null && zecChange24h != null
      ? (zecPrice * zecChange24h) / (100 + zecChange24h)
      : null

  // Ratio averages and true period changes come from /api/prices' buffered
  // full-history stats, not the chart's sliced history. Recomputing these from
  // a 1D chart made 7D/30D/90D collapse to the same intraday value.
  const ratioStats = useMemo(() => {
    const source =
      ratioMode === "btcZec" ? stats?.zecBtcRatio : stats?.ratio
    const avg24h = source?.avg24h ?? null
    const avg7d = source?.avg7d ?? null
    const avg30d = source?.avg30d ?? null
    const avg90d = source?.avg3m ?? null
    const vs = (avg: number | null) =>
      avg != null && avg > 0 && activeRatio != null
        ? ((activeRatio - avg) / avg) * 100
        : null
    const relative24h = (
      numeratorChange: number | null,
      denominatorChange: number | null
    ) => {
      if (
        numeratorChange == null ||
        denominatorChange == null ||
        denominatorChange <= -100
      ) {
        return null
      }
      return (
        ((1 + numeratorChange / 100) / (1 + denominatorChange / 100) - 1) *
        100
      )
    }
    const liveChange24h =
      ratioMode === "btcZec"
        ? relative24h(zecChange24h, btcChange24h)
        : relative24h(cyphRatioChange24h, zecChange24h)

    return {
      avg24h,
      avg7d,
      avg30d,
      avg90d,
      vsAvg7d: vs(avg7d),
      change24h: liveChange24h ?? source?.change24h ?? null,
      change7d: source?.change7d ?? null,
      change30d: source?.change30d ?? null,
      change90d: source?.change90d ?? null,
    }
  }, [
    activeRatio,
    btcChange24h,
    cyphRatioChange24h,
    ratioMode,
    stats,
    zecChange24h,
  ])

  // Sparkline sources — historical closes plus a live tail point that
  // matches the headline prices, so ratio/price ticks don't visually
  // lag the card values between /api/prices cache refreshes.
  const cyphSpark = useMemo(
    () => liveHistory.flatMap((h) => (h.cyph != null ? [h.cyph] : [])),
    [liveHistory]
  )
  const zecSpark = useMemo(() => liveHistory.map((h) => h.zec), [liveHistory])
  const ratioSpark = useMemo(
    () =>
      liveHistory.flatMap((h) => {
        const r = ratioMode === "btcZec" ? h.zecBtcRatio : h.ratio
        return r != null ? [r] : []
      }),
    [liveHistory, ratioMode]
  )

  // Dedicated history for the overlay chart so its local period doesn't
  // affect the rest of the dashboard.
  const chartHistory = useMemo(
    () => chartPrices?.history ?? EMPTY_HISTORY,
    [chartPrices]
  )
  const liveChartHistory = useMemo(
    () =>
      withLiveTail(chartHistory, {
        cyph: cyphPrice,
        zec: zecPrice,
        btc: btcPrice,
      }),
    [chartHistory, cyphPrice, zecPrice, btcPrice]
  )

  // Memoized snapshot used as the chart's `data` prop. It follows the
  // selected chart history and the same live tail used by the cards, so
  // the overlay endpoint and ratio card land on the same latest values.
  const chartData = useMemo(
    () =>
      liveChartHistory.map((h) => ({
        date: h.date,
        cyph: ratioMode === "btcZec" ? h.btc : h.cyph,
        zec: h.zec,
        ratio: ratioMode === "btcZec" ? h.zecBtcRatio : h.ratio,
      })),
    [liveChartHistory, ratioMode]
  )
  const isMobile = useIsMobile()
  const [chartViewportReady, setChartViewportReady] = useState(false)
  useEffect(() => setChartViewportReady(true), [])
  const topTileCount = Math.max(1, dashboardTiles.length)
  // Keep the first render mobile-first. An inline desktop grid override was
  // previously applied before useIsMobile's effect ran, briefly squeezing
  // every card into one row and pulling the price overlay into view.
  const topGridColumns =
    topTileCount === 1
      ? "md:grid-cols-1"
      : topTileCount === 2
        ? "md:grid-cols-2"
        : topTileCount === 3
          ? "md:grid-cols-3"
          : "md:grid-cols-4"
  const tileOrder = (key: DashboardTileKey) => {
    const index = dashboardTiles.indexOf(key)
    return index >= 0 ? index : 99
  }

  // Rank chip → ZEC's neighbours on the leaderboard for the supply
  // panel "RANK NEIGHBORS" widget.
  const zecRank = zecStats?.rank ?? null
  const rankNeighbors = useMemo(() => {
    const coins = markets?.coins ?? []
    if (zecRank == null || coins.length === 0) return []
    return coins.filter((c) => Math.abs(c.rank - zecRank) <= 2)
  }, [markets, zecRank])
  const nextCoin = useMemo(() => {
    if (zecRank == null || !markets) return null
    return markets.coins.find((c) => c.rank === zecRank - 1) ?? null
  }, [markets, zecRank])
  const deltaToNextPrice =
    nextCoin?.marketCap != null &&
    zecStats?.marketCap != null &&
    zecStats?.circulating != null &&
    zecStats.circulating > 0
      ? (nextCoin.marketCap - zecStats.marketCap) / zecStats.circulating
      : null

  // Treasury-derived NAV (intrinsic value per CYPH share). Replaces
  // the hard-coded 240_000 from the redesign mockup with the real
  // total-ZEC-held figure from /api/cypherpunk-holdings.
  const totalZec =
    holdings?.summary.totalZec ?? cypherpunkMnav?.zecHoldings ?? null
  const sharesOutstanding = quote?.sharesOutstanding ?? null
  const treasuryUsd =
    totalZec != null && zecPrice != null
      ? totalZec * zecPrice
      : cypherpunkMnav?.netAssetValue ?? null
  // mNAV as cypherpunk.com reports it (EV / NAV). We surface their
  // published figure rather than reconstruct their proforma-net-cash EV
  // (not derivable from public data); fall back to EV / live-treasury only
  // if the published value is missing.
  const mnavValue =
    cypherpunkMnav?.mnav ??
    (cypherpunkMnav?.enterpriseValue != null &&
    treasuryUsd != null &&
    treasuryUsd > 0
      ? cypherpunkMnav.enterpriseValue / treasuryUsd
      : null)
  // Our OWN transparent NAV per share: live ZEC treasury ÷ CYPH share
  // counts (common O/S + ITM-diluted, from the 10-Q). Independent of
  // cypherpunk's mNAV so the two are shown side by side, clearly labeled.
  const cyphNav = computeCyphNav({
    treasuryUsd,
    cyphPrice,
    commonSharesLive: sharesOutstanding,
    publishedDilutedShares: cypherpunkMnav?.fullyDilutedShares,
  })
  const hasCyphValuation =
    cyphNav.navPerShareOS != null ||
    cyphNav.navPerShareDiluted != null ||
    mnavValue != null ||
    treasuryUsd != null ||
    cypherpunkMnav?.enterpriseValue != null

  const shielded = zecStats?.shieldedBreakdown ?? null
  const shieldedPct =
    zecStats?.shieldedPct ?? shielded?.pct ?? null
  // Circulating supply drives the MINED %/bar. Prefer /api/zec-stats, which
  // is now backed by cipherscan's live on-chain chainSupply (fresher than the
  // markets leaderboard's CoinGecko/CMC circulating, which lags ~a day). Fall
  // back to the markets leaderboard only if zec-stats is unavailable, so the
  // bar still renders during a zec-stats outage. (`zecCoin` is defined above.)
  const circulating =
    zecStats?.circulating ?? zecCoin?.circulatingSupply ?? null

  // Scheduled US equity session (overnight / pre / regular / after) from the
  // ET trading calendar, independent of whether a print has landed yet. Drives
  // the tile's countdown, and gives us an authoritative holiday signal that
  // the stale-tick heuristic below can only approximate.
  const marketSchedule = useMarketSession()

  // Effective "is the market actually open right now" — used to override
  // Yahoo's occasionally-wrong marketState on US market holidays.
  // Yahoo's quote service doesn't always consult the NASDAQ trading
  // calendar; on holidays like Memorial Day or Thanksgiving it will
  // still report marketState=REGULAR during the 9:30 AM ET - 4 PM ET
  // window even though no trading is happening. Detect this by
  // checking whether the most recent regular-session tick is stale
  // (>4h). During a real trading day the tick refreshes constantly so
  // <5 min stale is normal; >4h can only happen on a closed day.
  const regularTickAgeMs = quoteRegularTickAgeMs
  const hasFreshRegularTick =
    regularTickAgeMs != null && regularTickAgeMs >= 0
      ? regularTickAgeMs < FRESH_REGULAR_TICK_MS
      : false
  const marketIsOpen = (() => {
    if (usesChartCyphTick) return true
    if (quote?.marketState === "REGULAR") {
      if (regularTickAgeMs == null) return true // no signal either way
      return regularTickAgeMs < HOLIDAY_TICK_THRESHOLD_MS
    }
    return isRegularTradingWindowEt() && hasFreshRegularTick
  })()

  // CYPH market-state → badge text. REGULAR shows OPEN; pre/after/
  // overnight surface their own labels so the badge reads like the
  // CMS-style status pill the new design wants. When Yahoo claims
  // REGULAR but the tick is stale (holiday detection above), we
  // render HOLIDAY so the user isn't misled into thinking the price
  // above is a live intraday tick.
  //
  // The badge must agree with the price the tile actually shows. The
  // headline price comes from `pickLiveCyph`, surfaced here via
  // `cyphSessionDetail.session`. When an extended-hours print is
  // unavailable (Yahoo dropped the field, or we're serving a fallback /
  // cached quote that lacks it), the price falls back to the last completed
  // regular close and `session` becomes "REGULAR" — even though Yahoo's raw
  // `marketState` may still report PRE / POST / POSTPOST. Keying the badge
  // off the raw `marketState` in that case stamps a stale close as
  // "PRE / AFT / OVN" (the "says active but shows the close" bug), so we
  // drive the extended-session labels off the *sourced* session instead.
  // That guarantees the badge and the number below it can never disagree.
  const sourcedSession = cyphSessionDetail.session
  const cyphMarketBadge = marketIsOpen
    ? "OPEN"
    : sourcedSession === "PRE"
      ? "PRE"
      : sourcedSession === "POST"
        ? "AFT"
        : sourcedSession === "OVN"
          ? "OVN"
          : // The trading calendar knows a closure for certain, where the
            // stale-tick check above can only infer one. Gated on nothing
            // being scheduled to trade, so the evening of a holiday — when
            // Blue Ocean does open at 20:00 ET — isn't stamped HOLIDAY.
            marketSchedule?.holiday && !marketSchedule.current
            ? "HOLIDAY"
            : quote?.marketState === "REGULAR"
              ? "HOLIDAY"
              : cyphPrice != null
                ? "LAST"
                : quote?.marketState ?? "—"

  return (
    <>
      {/* Period selector lives in EShell's headerExtra slot (rendered
          from app/page.tsx). The "N candles" caption was removed at
          the user's request — it ate a row of vertical space on
          desktop without adding actionable info. */}

      {/* IRONWOOD — full-width countdown / migration banner. Sits above
          the readouts because the activation is a one-time, time-critical
          event; it flips itself to migration progress once the gate opens.
          Hideable via Settings for anyone who doesn't want it. */}
      {settings.ironwoodBanner && <IronwoodBanner />}

      {/* THREE READOUTS — CYPH / ZEC / RATIO. Each is clickable in the
          new design: CYPH → /holdings, ZEC → /stats, RATIO → /estimator.
          We wrap each CornerBox in a Link so middle-click / cmd-click
          opens in a new tab; the CornerBox's `interactive` prop powers
          the hover glow + corner-glyph brighten. Tile gap shrinks on
          mobile so three stacked cards take less vertical space. */}
      <section
        className={`grid grid-cols-1 ${topGridColumns} gap-2 md:gap-3 mb-2 md:mb-3`}
      >
        {/* CYPH */}
        <div
          className="relative block group h-full"
          style={{
            order: tileOrder("cyph"),
            display: dashboardTiles.includes("cyph") ? undefined : "none",
          }}
        >
          <CornerBox color={paletteVar("cyph")} interactive className="flex flex-col h-full">
            {/* Stretched link — the whole card navigates to /holdings, but as
                an overlay sibling (z-1) rather than an <a> wrapping the card,
                so the mNAV InfoTip button (raised to z-2) isn't a nested
                interactive control inside an anchor. */}
            <Link
              href="/holdings"
              aria-label="Open CYPH holdings & treasury"
              className="absolute inset-0 z-[1] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
              style={{ outlineColor: paletteVar("cyph") }}
            />
            {/* Header = title + status chip only. 24H % lives on the
                "+$X today" line so chips stay same-size and never fight
                the perf readout for width. */}
            <div className="flex items-center justify-between gap-1.5 min-h-[18px]">
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className={TILE_TITLE}
                  style={{
                    color: paletteVar("cyph"),
                    textShadow: `0 0 6px ${paletteVar("cyph")}55`,
                  }}
                >
                  CYPH
                </span>
                <span
                  className={TILE_CHIP}
                  style={{
                    borderColor: `${paletteVar("cyph")}55`,
                    color: paletteVar("cyph"),
                  }}
                >
                  {cyphMarketBadge}
                </span>
                {/* Session countdown — time left in the live session, or the
                    next venue to open and how long until it does. No longer
                    needs a container-width gate: moving the mining chip out of
                    this row freed ~94px, so title + status + countdown +
                    DEPTH now fit even in a 211px-wide tile. */}
                <SessionClock />
              </div>
              {/* DEPTH toggle — same name, same right-hand position and the
                  same chip treatment as the ZEC tile's, so the two tiles read
                  as one convention rather than two. Writes the setting the
                  Settings page does. */}
              <button
                type="button"
                aria-pressed={settings.cyphDepthTile}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setSetting("cyphDepthTile", !settings.cyphDepthTile)
                }}
                className={`relative z-[2] ${TILE_CHIP_LINK}`}
                style={{
                  borderColor: settings.cyphDepthTile
                    ? paletteVar("cyph")
                    : withAlpha(paletteVar("text"), 27),
                  color: settings.cyphDepthTile
                    ? paletteVar("cyph")
                    : paletteVar("text"),
                  background: settings.cyphDepthTile
                    ? withAlpha(paletteVar("cyph"), 12)
                    : "transparent",
                  opacity: settings.cyphDepthTile ? 1 : 0.7,
                  outlineColor: paletteVar("cyph"),
                }}
                title={
                  settings.cyphDepthTile
                    ? "Hide the CYPH order-book strip"
                    : "Show the CYPH order book (last completed session — equity depth is published 24h in arrears)"
                }
              >
                DEPTH
              </button>
            </div>
            {/* Mining lives on the mNAV line when that box renders. When it
                does not — no treasury, shares or ZEC price yet — the chip has
                nowhere to sit, so it falls back to its own row rather than
                disappearing. */}
            {!hasCyphValuation && (
              <div className="relative z-[2] mt-2 flex items-center">
                <MiningChip />
              </div>
            )}
            {/* Price block — fixed min-height across tiles so sparklines
                land on the same Y. Extended hours expands by one line
                for the close print. */}
            <div
              className={
                cyphSessionDetail.session === "REGULAR"
                  ? "mt-2 min-h-[3.5rem] md:min-h-[3.75rem]"
                  : "mt-2 min-h-[4.5rem] md:min-h-[4.75rem]"
              }
            >
              <div className="text-3xl md:text-4xl font-bold leading-none">
                <LiveNumber
                  value={cyphPrice}
                  format={(v) => "$" + v.toFixed(2)}
                  color={paletteVar("cyph")}
                />
              </div>
              {cyphSessionDetail.session === "REGULAR"
                ? // REGULAR: "+$X today (+Y%)" — pct moved out of the
                  // header so OPEN / LIVE chips share one row cleanly.
                  cyphDollarChange != null &&
                  cyphChange24h != null &&
                  Math.abs(cyphChange24h) >= 0.005 && (
                    <div
                      className="text-[11px] tabular-nums mt-0.5"
                      style={{
                        color:
                          cyphChange24h >= 0
                            ? paletteVar("cyph")
                            : E_STATIC.red,
                      }}
                    >
                      {cyphChange24h >= 0 ? "+" : "-"}$
                      {Math.abs(cyphDollarChange).toFixed(2)} today
                      <span style={{ opacity: 0.85 }}>
                        {" "}
                        ({cyphChange24h >= 0 ? "+" : ""}
                        {cyphChange24h.toFixed(2)}%)
                      </span>
                    </div>
                  )
                : // Extended-hours: delta vs close + close print.
                  (() => {
                    const change = cyphSessionDetail.change
                    const pct = cyphSessionDetail.changePct
                    const close = cyphSessionDetail.prevClose
                    const closeTime = cyphSessionDetail.prevCloseTime
                    return (
                      <>
                        {change != null && pct != null && (
                          <div
                            className="text-[11px] tabular-nums mt-0.5"
                            style={{
                              color:
                                change >= 0
                                  ? paletteVar("cyph")
                                  : E_STATIC.red,
                            }}
                          >
                            <span style={{ fontWeight: 600 }}>
                              {change >= 0 ? "+" : "-"}$
                              {Math.abs(change).toFixed(2)}
                            </span>
                            <span>
                              {" "}
                              ({pct >= 0 ? "+" : ""}
                              {pct.toFixed(2)}%)
                            </span>
                            <span style={{ opacity: 0.7 }}> vs close</span>
                          </div>
                        )}
                        {close != null && (
                          <div
                            className="text-[11px] tabular-nums mt-0.5"
                            style={{
                              color: paletteVar("text"),
                              opacity: 0.6,
                            }}
                          >
                            <span style={{ opacity: 0.85 }}>Close </span>
                            <span style={{ fontWeight: 600 }}>
                              ${close.toFixed(2)}
                            </span>
                            {closeTime != null && (
                              <span> · {fmtEtClock(closeTime, { withDayPrefix: true })}</span>
                            )}
                            {/* 24H close-to-close stays visible in extended
                                hours too (regular hours shows it on the
                                "today" line; don't let it vanish off-session). */}
                            {cyphChange24h != null &&
                              Math.abs(cyphChange24h) >= 0.005 && (
                                <span
                                  style={{
                                    color:
                                      cyphChange24h >= 0
                                        ? paletteVar("cyph")
                                        : E_STATIC.red,
                                  }}
                                >
                                  {" · 24H "}
                                  {/* Dollar move first, percent in parens —
                                      same order as the regular-session
                                      "today" line above. Percent alone if the
                                      session's dollar delta is unavailable. */}
                                  {cyphDollarChange != null ? (
                                    <>
                                      {cyphChange24h >= 0 ? "+" : "-"}$
                                      {Math.abs(cyphDollarChange).toFixed(2)}
                                      {" ("}
                                      {cyphChange24h >= 0 ? "+" : ""}
                                      {cyphChange24h.toFixed(2)}
                                      {"%)"}
                                    </>
                                  ) : (
                                    <>
                                      {cyphChange24h >= 0 ? "+" : ""}
                                      {cyphChange24h.toFixed(2)}%
                                    </>
                                  )}
                                </span>
                              )}
                          </div>
                        )}
                      </>
                    )
                  })()}
            </div>
            {/* Sparkline lives in a min-height wrapper so the
                at-a-glance row below sits at the same Y as the ZEC
                tile even when the price series is still loading. */}
            <div className="mt-3 min-h-[2rem]">
              {cyphSpark.length >= 2 ? (
                <PhosphorSpark
                  values={cyphSpark}
                  color={paletteVar("cyph")}
                  width={300}
                  height={32}
                  glow={false}
                />
              ) : (
                <Skeleton height={28} />
              )}
            </div>
            {/* CYPH order book. Off by default — see the BOOK chip above.
                Placed directly after the sparkline so it lands in the same
                vertical slot as the ZEC tile's depth strip. Like that one, it
                only subscribes to its feed while rendered, so the poll costs
                nothing when hidden. */}
            {settings.cyphDepthTile && <CyphDepthStrip />}
            {/* Treasury NAV at-a-glance row — sits between the sparkline
                and the perf grid so the user sees the treasury-derived
                metrics in the same vertical position as the ZEC tile's
                TX/VOL/MINED row + the RATIO tile's avg row. Only
                renders when both ZEC treasury + shares-out + ZEC price
                are present (and the treasury actually holds ZEC) so we
                never show "$0.00 NAV/SHARE" implying an empty
                treasury. */}
            {hasCyphValuation && (
              <div
                className="relative z-[2] mt-3 @container px-2 py-2"
                style={{
                  border: `1px solid ${paletteVar("ratio")}40`,
                  background: `${paletteVar("ratio")}05`,
                }}
              >
                {/* Lead — mNAV exactly as cypherpunk.com reports it
                    (EV ÷ treasury). Shown as-is with the formula stated and
                    an (i) for how their EV is built; we don't reconstruct
                    it. 0.85x already reads as "below par" so no extra %. */}
                <div className="flex items-baseline justify-between gap-2">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span
                      className="text-xl font-bold leading-none tabular-nums @[24rem]:text-2xl"
                      style={{
                        color: paletteVar("ratio"),
                        textShadow: `0 0 10px ${paletteVar("ratio")}55`,
                      }}
                    >
                      <LiveNumber
                        value={mnavValue}
                        format={(v) => v.toFixed(2) + "x"}
                        color={paletteVar("ratio")}
                      />
                    </span>
                    <span
                      className="inline-flex items-center gap-1 text-[10px] font-bold tracking-[0.14em] @[24rem]:text-[11px]"
                      style={{ color: paletteVar("ratio"), opacity: 0.85 }}
                    >
                      <VaultIcon />
                      <span>mNAV = EV ÷ TREAS.</span>
                    </span>
                    {/* The (i) explains this formula, so it sits against it
                        rather than at the far right of the row, where it read
                        as belonging to the mining chip it happened to be
                        beside.

                        A sibling of the label, not a child of it: that span
                        carries opacity 0.85, and ancestor opacity applies to
                        the entire subtree with no way for a descendant to opt
                        out, so nesting the tip inside would dim the button and
                        its popover along with the text. */}
                    <InfoTip color={paletteVar("ratio")} label="How mNAV is calculated">
                      <strong style={{ color: paletteVar("ratio") }}>mNAV</strong>{" "}
                      is cypherpunk.com&apos;s reported enterprise value &divide; ZEC
                      treasury value. Their EV folds in proforma net cash over a
                      diluted share base and isn&apos;t reproducible from public data,
                      so it&apos;s shown as published. The{" "}
                      <strong style={{ color: paletteVar("amber") }}>NAV/share</strong>{" "}
                      figures are ours: live ZEC treasury &divide; CYPH share counts
                      (O/S {fmtCompactNumberLocal(cyphNav.commonShares)},{" "}
                      {cyphNav.dilutedSharesSource === "published"
                        ? "fully diluted"
                        : "ITM-diluted"}{" "}
                      {fmtCompactNumberLocal(cyphNav.dilutedShares)}
                      {cyphNav.dilutedSharesSource === "published"
                        ? ", as cypherpunk.com reports it"
                        : ""}
                      ).
                    </InfoTip>
                  </div>
                  {/* Mining run-rate. It used to be pinned right in the tile
                      header, where it took ~94px of the row that title, status,
                      countdown and DEPTH also wanted; here it rides the mNAV
                      line, which has spare width. Rendered on its own row
                      instead when this box is absent, so it appears exactly
                      once either way. */}
                  <span className="shrink-0 inline-flex items-center">
                    <MiningChip />
                  </span>
                </div>

                {/* Our OWN transparent NAV per share — kept clearly separate
                    from mNAV: one column per share base, each with its own
                    signed discount/premium to the live price. Common trades
                    below NAV; fully-diluted above, because the cheap warrants
                    dilute the per-share backing. */}
                <div
                  className="mt-2 grid grid-cols-2 gap-px"
                  style={{ border: `1px solid ${paletteVar("ratio")}33` }}
                >
                  <NavShareCell
                    label="NAV/SH · O/S"
                    nav={cyphNav.navPerShareOS}
                    vsNavPct={cyphNav.vsNavOSPct}
                  />
                  <NavShareCell
                    label="NAV/SH · DIL."
                    nav={cyphNav.navPerShareDiluted}
                    vsNavPct={cyphNav.vsNavDilutedPct}
                  />
                </div>

                {/* Traceability — the inputs behind every figure above. */}
                <div
                  className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] tracking-[0.05em]"
                  style={{ color: paletteVar("text"), opacity: 0.6 }}
                >
                  <TraceStat
                    label="TREAS"
                    value={fmtCompactUSD(treasuryUsd)}
                    color={paletteVar("amber")}
                  />
                  <TraceStat
                    label="O/S"
                    value={fmtCompactNumberLocal(cyphNav.commonShares)}
                    color={paletteVar("text")}
                  />
                  <TraceStat
                    label="DIL"
                    value={fmtCompactNumberLocal(cyphNav.dilutedShares)}
                    color={paletteVar("text")}
                  />
                </div>
              </div>
            )}
            <div className="mt-3 -mx-3">
              <PerfGrid
                p24={cyphPerf24}
                p7={cyphPerf7}
                p30={cyphPerf30}
                p90={cyphPerf90}
              />
            </div>
            <div className="mt-2 md:mt-auto md:pt-3 grid grid-cols-2 gap-x-3 text-[11px]">
              <MetaRow label="MCAP" value={fmtCompactUSD(quote?.marketCap ?? null)} />
              <MetaRow
                label="EV"
                value={fmtCompactUSD(cypherpunkMnav?.enterpriseValue ?? null)}
              />
              <MetaRow
                label="VOL 24H"
                value={
                  cyphVolume?.volume24h != null
                    ? fmtCompactNumberLocal(cyphVolume.volume24h)
                    : "--"
                }
              />
              <MetaRow
                label="VOL VS 7D"
                value={
                  cyphVolume?.deltaVs7dAvgPct != null
                    ? `${cyphVolume.deltaVs7dAvgPct >= 0 ? "+" : ""}${cyphVolume.deltaVs7dAvgPct.toFixed(1)}%`
                    : "--"
                }
                valueColor={
                  cyphVolume?.deltaVs7dAvgPct == null
                    ? undefined
                    : cyphVolume.deltaVs7dAvgPct >= 0
                      ? paletteVar("cyph")
                      : E_STATIC.red
                }
              />
            </div>
          </CornerBox>
        </div>

        {/* ZEC — the whole tile navigates to the ZEC stats tab via a
            stretched overlay (z-1), matching the CYPH/RATIO tiles; the
            internal links (Ironwood, shielded, exchanges) sit at z-2 above
            it so they keep their own destinations. */}
        <div
          className="relative block group h-full"
          style={{
            order: tileOrder("zec"),
            display: dashboardTiles.includes("zec") ? undefined : "none",
          }}
        >
          <CornerBox color={paletteVar("zec")} interactive className="flex flex-col h-full">
            <Link
              href="/stats?view=supply"
              aria-label="Open ZEC stats"
              className="absolute inset-0 z-[1] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
              style={{ outlineColor: paletteVar("zec") }}
            />
            <div className="flex items-center justify-between gap-1.5 min-h-[18px]">
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className={TILE_TITLE}
                  style={{
                    color: paletteVar("zec"),
                    textShadow: `0 0 6px ${paletteVar("zec")}55`,
                  }}
                >
                  ZEC
                </span>
                {zecRank != null && (
                  <Link
                    href="/stats"
                    className={`relative z-[2] ${TILE_CHIP_LINK}`}
                    style={{
                      borderColor: `${paletteVar("zec")}55`,
                      color: paletteVar("zec"),
                      outlineColor: paletteVar("zec"),
                    }}
                    title="Open ZEC rankings"
                    aria-label={`ZEC rank #${zecRank} — open rankings`}
                  >
                    #{zecRank}
                  </Link>
                )}
              </div>
              {/* DEPTH toggle — lives in the tile itself so the order-book
                  strip is one tap away, and writes the same setting the
                  Settings page does (Settings → ORDER DEPTH). z-2 keeps it
                  above the tile's stretched navigation overlay. */}
              <button
                type="button"
                aria-pressed={settings.depthTile}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setSetting("depthTile", !settings.depthTile)
                }}
                className={`relative z-[2] ${TILE_CHIP_LINK}`}
                // Alpha via withAlpha rather than a hex suffix on
                // paletteVar() — the suffix form doesn't survive var()
                // substitution, so the ON tint would silently never paint.
                style={{
                  borderColor: settings.depthTile
                    ? paletteVar("zec")
                    : withAlpha(paletteVar("text"), 27),
                  color: settings.depthTile
                    ? paletteVar("zec")
                    : paletteVar("text"),
                  background: settings.depthTile
                    ? withAlpha(paletteVar("zec"), 12)
                    : "transparent",
                  opacity: settings.depthTile ? 1 : 0.7,
                  outlineColor: paletteVar("zec"),
                }}
                title={
                  settings.depthTile
                    ? "Hide the aggregated order-book depth strip"
                    : "Show aggregated order-book depth (bids vs asks, live)"
                }
              >
                DEPTH
              </button>
            </div>
            <div className="mt-2 min-h-[3.5rem] md:min-h-[3.75rem]">
              <div className="text-3xl md:text-4xl font-bold leading-none">
                <LiveNumber
                  value={zecPrice}
                  format={(v) => "$" + v.toFixed(2)}
                  color={paletteVar("zec")}
                />
              </div>
              {zecDollarChange != null &&
                zecChange24h != null &&
                Math.abs(zecChange24h) >= 0.005 && (
                  <div
                    className="text-[11px] tabular-nums mt-0.5"
                    style={{
                      color:
                        zecChange24h >= 0
                          ? paletteVar("cyph")
                          : E_STATIC.red,
                    }}
                  >
                    {zecChange24h >= 0 ? "+" : "-"}$
                    {Math.abs(zecDollarChange).toFixed(2)} 24H
                    <span style={{ opacity: 0.85 }}>
                      {" "}
                      ({zecChange24h >= 0 ? "+" : ""}
                      {zecChange24h.toFixed(2)}%)
                    </span>
                  </div>
                )}
            </div>
            <div className="mt-3 min-h-[2rem]">
              {zecSpark.length >= 2 ? (
                <PhosphorSpark
                  values={zecSpark}
                  color={paletteVar("zec")}
                  width={300}
                  height={32}
                  glow={false}
                />
              ) : (
                <Skeleton height={28} />
              )}
            </div>
            {/* Aggregated order-book depth. Off by default — see the DEPTH
                chip above. The strip only subscribes to the feed while it is
                actually rendered, so the poll costs nothing when hidden. */}
            {settings.depthTile && <DepthStrip />}
            {/* ZEC at-a-glance row — sits in the same vertical
                position as the CYPH tile's NAV row so the two tiles
                read as a parallel grid (DAILY TX / VOL 24H / MINED %
                here mirrors NAV/SHARE / TREASURY / DISCOUNT there). */}
            {(dailyZecTx != null ||
              zecVolume24h != null ||
              shieldedPct != null) && (
              <div
                className="mt-3 grid grid-cols-3 gap-px"
                style={{ border: `1px solid ${paletteVar("zec")}33` }}
              >
                <NavCell
                  label="DAILY TX"
                  value={dailyZecTx ?? 0}
                  format={(v) =>
                    v >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toLocaleString()
                  }
                  color={paletteVar("zec")}
                  icon={<ActivityIcon />}
                />
                <NavCell
                  label="VOL 24H"
                  value={zecVolume24h ?? 0}
                  format={fmtCompactUSD}
                  color={paletteVar("zec")}
                  icon={<BarsIcon />}
                />
                <Link
                  href="/shielding"
                  className="relative z-[2] block focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-2px]"
                  style={{ outlineColor: paletteVar("ratio") }}
                  title="Open shielding details"
                >
                  <NavCell
                    label="SHIELDED"
                    value={shieldedPct ?? 0}
                    format={(v) => v.toFixed(1) + "%"}
                    color={paletteVar("zec")}
                    icon={<ShieldIcon />}
                  />
                </Link>
              </div>
            )}
            {/* TOP MARKETS — at-a-glance breakdown of where the most
                ZEC volume is currently changing hands. Replaces the
                earlier flex-chip strip whose column alignment broke
                whenever an exchange had a long name (e.g. "Coinbase
                Exchange") next to a short one ("KuCoin"). The new
                layout is a 3-row grid:
                  - row background = horizontal share-fill (linear
                    gradient sized by `share * 100%`) so the eye reads
                    relative volume without needing a separate bar.
                  - columns: NAME (1fr, truncate) | SHARE (54px, fixed)
                    | 24H CHANGE (56px, fixed). Fixed-width columns
                    keep the percentages stacked in a clean vertical
                    line across rows.
                The full breakdown + heat-map lives on /stats → ZEC →
                EXCHANGES. */}
            {topExchanges.length > 0 && (
              <div className="relative z-[2] mt-2">
                <div
                  className="grid grid-cols-[1fr_64px_64px] gap-2 mb-1 text-[9px] tracking-[0.2em]"
                  style={{ color: paletteVar("text") }}
                >
                  <Link
                    href="/exchanges"
                    // Same reason as the stats view tabs: an inline opacity
                    // beats `hover:opacity-100`, so keep it in a class.
                    className="min-w-0 truncate opacity-85 transition-opacity hover:opacity-100"
                    style={{
                      color: paletteVar("zec"),
                      textShadow: `0 0 5px ${paletteVar("zec")}55`,
                    }}
                    title="Open exchange stats"
                  >
                    EXCH -&gt;
                  </Link>
                  <span className="text-right" style={{ opacity: 0.7 }}>SHARE</span>
                  <span className="text-right" style={{ opacity: 0.7 }}>ΔVOL</span>
                </div>
                <Link
                  href="/exchanges"
                  className="block border transition-colors hover:bg-white/5"
                  style={{ borderColor: `${paletteVar("zec")}33` }}
                  title="Open exchange stats"
                >
                  {topExchanges.map((ex, i) => {
                    const sharePct = ex.share * 100
                    const change = ex.volumeChange24h
                    const changeColor =
                      change == null
                        ? paletteVar("text")
                        : change >= 0
                          ? paletteVar("zec")
                          : E_STATIC.red
                    // Use the actual compare window the API reported
                    // (warm-up after deploy may be e.g. 4h, not 24h)
                    // so the tooltip is honest. Steady state (>=22h)
                    // reads "vs ~24h ago".
                    const windowSuffix =
                      ex.volumeChangeWindowHours == null
                        ? ""
                        : ex.volumeChangeWindowHours >= 22
                          ? "vs ~24h ago"
                          : `vs ~${Math.round(ex.volumeChangeWindowHours)}h ago`
                    return (
                      <div
                        key={ex.exchangeId}
                        className="grid grid-cols-[1fr_64px_64px] gap-2 items-center px-2 py-1 text-[11px] tabular-nums"
                        style={{
                          // The fill colour stops at `sharePct` and
                          // becomes transparent after — so an exchange
                          // with 21% share fills 21% of the row width.
                          background: `linear-gradient(to right, ${paletteVar("zec")}1f 0%, ${paletteVar("zec")}1f ${sharePct}%, transparent ${sharePct}%, transparent 100%)`,
                          // Subtle separator line between rows; skip
                          // the one above the first row (it sits
                          // against the container border).
                          borderTop:
                            i === 0
                              ? "none"
                              : `1px solid ${paletteVar("zec")}1a`,
                        }}
                        title={`${ex.exchange} · ${ex.marketCount} pair${ex.marketCount === 1 ? "" : "s"} · ${fmtCompactUSD(ex.volumeUsd24h)} 24h volume${change != null ? ` · ${change >= 0 ? "+" : ""}${change.toFixed(1)}% ${windowSuffix}` : ""}`}
                      >
                        <span
                          className="truncate font-bold"
                          style={{ color: paletteVar("zec") }}
                        >
                          {ex.exchange}
                        </span>
                        <span
                          className="text-right font-bold"
                          style={{ color: paletteVar("zec") }}
                        >
                          {sharePct.toFixed(1)}%
                        </span>
                        <span
                          className="text-right"
                          style={{
                            color: changeColor,
                            opacity: change == null ? 0.4 : 0.95,
                          }}
                        >
                          {change == null
                            ? "—"
                            : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`}
                        </span>
                      </div>
                    )
                  })}
                </Link>
              </div>
            )}
            <div className="mt-3 -mx-3">
              <PerfGrid
                p24={zecChange24h}
                p7={stats?.zec.change7d ?? null}
                p30={stats?.zec.change30d ?? null}
                p90={stats?.zec.change90d ?? null}
              />
            </div>
            <div className="mt-2 md:mt-auto md:pt-3 grid grid-cols-2 gap-x-3 text-[11px]">
              <MetaRow
                label="MCAP"
                value={fmtCompactUSD(zecStats?.marketCap ?? null)}
              />
              <MetaRow
                label="FLIP"
                value={
                  nextCoin && deltaToNextPrice != null
                    ? `${nextCoin.symbol} +$${deltaToNextPrice.toFixed(0)}`
                    : "—"
                }
              />
              <MetaRow
                label={
                  <span className="inline-flex items-center gap-1">
                    <MinedIcon />
                    MINED
                  </span>
                }
                value={
                  circulating != null
                    ? ((circulating / 21e6) * 100).toFixed(2) + "%"
                    : "—"
                }
              />
              <MetaRow
                label="SUPPLY"
                value={
                  circulating != null
                    ? (circulating / 1e6).toFixed(2) + "M"
                    : "—"
                }
              />
            </div>
          </CornerBox>
        </div>

        {/* RATIO */}
        <div
          className="relative block group h-full"
          style={{
            order: tileOrder("ratio"),
            display: dashboardTiles.includes("ratio") ? undefined : "none",
          }}
        >
          <CornerBox color={paletteVar("ratio")} interactive className="flex flex-col h-full">
            <Link
              href={ratioMode === "btcZec" ? "/bitcoin" : "/estimator"}
              aria-label={
                ratioMode === "btcZec"
                  ? "Open Bitcoin and ZEC analytics"
                  : "Open the CYPH estimator"
              }
              className="absolute inset-0 z-[1] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
              style={{ outlineColor: paletteVar("ratio") }}
            />
            <div className="flex items-center justify-between gap-1.5 min-h-[18px]">
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className={TILE_TITLE}
                  style={{
                    color: paletteVar("ratio"),
                    textShadow: `0 0 6px ${paletteVar("ratio")}55`,
                  }}
                >
                  {activeRatioLabel}
                </span>
                <span
                  className={TILE_CHIP}
                  style={{
                    borderColor: `${paletteVar("ratio")}55`,
                    color: paletteVar("ratio"),
                  }}
                >
                  LIVE
                </span>
              </div>
              {/* CYPH/BTC picker pinned top-right now that header is free. */}
              <span className="relative z-[2] shrink-0">
                <RatioModeToggle value={ratioMode} onChange={setRatioMode} />
              </span>
            </div>
            <div className="mt-2 min-h-[3.5rem] md:min-h-[3.75rem]">
              <div className="text-3xl md:text-4xl font-bold leading-none">
                <LiveNumber
                  value={activeRatio}
                  format={formatActiveRatio}
                  color={paletteVar("ratio")}
                />
              </div>
              {/* No dollar change on ratio — put 7D % under the price
                  so the sparkline still aligns with CYPH/ZEC today lines. */}
              {ratioStats.vsAvg7d != null &&
                Number.isFinite(ratioStats.vsAvg7d) &&
                Math.abs(ratioStats.vsAvg7d) >= 0.005 && (
                  <div
                    className="text-[11px] tabular-nums mt-0.5"
                    style={{
                      color:
                        ratioStats.vsAvg7d >= 0
                          ? paletteVar("cyph")
                          : E_STATIC.red,
                    }}
                  >
                    {ratioStats.vsAvg7d >= 0 ? "+" : ""}
                    {ratioStats.vsAvg7d.toFixed(2)}% vs 7D AVG
                  </div>
                )}
            </div>
            <div className="mt-3 min-h-[2rem]">
              {ratioSpark.length >= 2 ? (
                <PhosphorSpark
                  values={ratioSpark}
                  color={paletteVar("ratio")}
                  width={300}
                  height={32}
                  glow={false}
                />
              ) : (
                <Skeleton height={28} />
              )}
            </div>
            {/* RATIO at-a-glance row — promotes the historical
                averages to the same vertical position the CYPH +
                ZEC tiles use for their treasury / TX rows, keeping
                the three tiles visually parallel. */}
            {(ratioStats.avg24h != null ||
              ratioStats.avg7d != null ||
              ratioStats.avg30d != null) && (
              <div
                className="mt-3 grid grid-cols-3 gap-px"
                style={{ border: `1px solid ${paletteVar("ratio")}33` }}
              >
                <NavCell
                  label="24H AVG"
                  value={ratioStats.avg24h ?? 0}
                  format={formatActiveRatio}
                  color={paletteVar("ratio")}
                />
                <NavCell
                  label="7D AVG"
                  value={ratioStats.avg7d ?? 0}
                  format={formatActiveRatio}
                  color={paletteVar("ratio")}
                />
                <NavCell
                  label="30D AVG"
                  value={ratioStats.avg30d ?? 0}
                  format={formatActiveRatio}
                  color={paletteVar("ratio")}
                />
              </div>
            )}
            <div className="mt-3 -mx-3">
              <PerfGrid
                p24={ratioStats.change24h}
                p7={ratioStats.change7d}
                p30={ratioStats.change30d}
                p90={ratioStats.change90d}
              />
            </div>
            <div className="mt-2 md:mt-auto md:pt-3 grid grid-cols-2 gap-x-3 text-[11px]">
              <MetaRow
                label="SOURCE"
                value={marketIsOpen ? "INTRADAY" : "EXT-HRS"}
              />
              <MetaRow
                label="PERIOD"
                value={period === "1" ? "1D" : period === "all" ? "ALL" : period + "D"}
              />
            </div>
          </CornerBox>
        </div>

        {/* PORTFOLIO */}
        <Link
          href="/portfolio"
          className="block group h-full"
          style={{
            order: tileOrder("portfolio"),
            display: dashboardTiles.includes("portfolio") ? undefined : "none",
          }}
        >
          <CornerBox color={paletteVar("ratio")} interactive className="flex flex-col h-full">
            <div className="flex items-center gap-1.5 min-h-[18px]">
              <span
                className={TILE_TITLE}
                style={{
                  color: paletteVar("ratio"),
                  textShadow: `0 0 6px ${paletteVar("ratio")}55`,
                }}
              >
                PORT
              </span>
              <span
                className={TILE_CHIP}
                style={{
                  borderColor: `${paletteVar("ratio")}55`,
                  color: portfolioLoading
                    ? paletteVar("text")
                    : portfolioReady
                      ? paletteVar("ratio")
                      : paletteVar("amber"),
                }}
              >
                {portfolioLoading ? "LOAD" : portfolioReady ? "LIVE" : "SETUP"}
              </span>
            </div>

            <div className="mt-2 min-h-[3.5rem] md:min-h-[3.75rem]">
              {portfolioLoading ? (
                <div className="flex h-[3.5rem] flex-col justify-center gap-2">
                  <Skeleton height={24} />
                  <Skeleton height={10} />
                </div>
              ) : portfolioReady ? (
                <>
                  <div className="text-3xl md:text-4xl font-bold leading-none">
                    <LiveNumber
                      value={portfolioMetrics.totalValue}
                      format={fmtUSD}
                      color={paletteVar("ratio")}
                    />
                  </div>
                  <div
                    className="text-[11px] tabular-nums mt-0.5"
                    style={{ color: signedColor(portfolioMetrics.dailyChange) }}
                  >
                    {fmtSignedUSDLocal(portfolioMetrics.dailyChange)} today
                    <span style={{ opacity: 0.85 }}>
                      {" "}
                      ({fmtSignedPctLocal(portfolioMetrics.dailyChangePct)})
                    </span>
                  </div>
                </>
              ) : (
                <div
                  className="flex h-[3.5rem] flex-col justify-center text-[11px] leading-relaxed"
                  style={{ color: paletteVar("text"), opacity: 0.7 }}
                >
                  Add CYPH/ZEC holdings to show this tile on the dashboard.
                </div>
              )}
            </div>

            <div className="mt-3 min-h-[2rem]">
              {portfolioLoading ? (
                <Skeleton height={28} />
              ) : portfolioReady && portfolioMetrics.history.length >= 2 ? (
                <PhosphorSpark
                  values={portfolioMetrics.history.slice(-30).map((row) => row.value)}
                  color={paletteVar("ratio")}
                  width={300}
                  height={32}
                  glow={false}
                />
              ) : (
                <Skeleton height={28} />
              )}
            </div>

            {portfolioLoading ? (
              <div className="mt-3">
                <Skeleton height={34} />
              </div>
            ) : (
              <div
                className="mt-3 grid grid-cols-3 gap-px"
                style={{ border: `1px solid ${paletteVar("ratio")}33` }}
              >
                <NavCell
                  label="CYPH"
                  value={portfolio.cyphShares}
                  format={(v) => fmtCompactNumberLocal(v)}
                  color={paletteVar("cyph")}
                />
                <NavCell
                  label="ZEC"
                  value={portfolio.zecCoins}
                  format={(v) =>
                    v >= 1000 ? fmtCompactNumberLocal(v) : v.toLocaleString("en-US", { maximumFractionDigits: 4 })
                  }
                  color={paletteVar("zec")}
                />
                <NavCell
                  label="P/L"
                  value={portfolioMetrics.totalPnl ?? 0}
                  format={(v) =>
                    portfolioMetrics.totalPnl == null ? "--" : fmtCompactUSD(v)
                  }
                  color={signedColor(portfolioMetrics.totalPnl)}
                />
              </div>
            )}

            <div className="mt-3 -mx-3">
              {portfolioLoading ? (
                <div className="px-3">
                  <Skeleton height={36} />
                </div>
              ) : (
                <PerfGrid
                  p24={portfolioMetrics.dailyChangePct}
                  p7={portfolioMetrics.windows.total.find((row) => row.key === "1W")?.pct ?? null}
                  p30={portfolioMetrics.windows.total.find((row) => row.key === "1M")?.pct ?? null}
                  p90={portfolioMetrics.windows.total.find((row) => row.key === "3M")?.pct ?? null}
                />
              )}
            </div>
            {portfolioLoading ? (
              <div className="mt-2 md:mt-auto md:pt-3">
                <Skeleton height={34} />
              </div>
            ) : (
              <div className="mt-2 md:mt-auto md:pt-3 grid grid-cols-2 gap-x-3 text-[11px]">
                <MetaRow
                  label="CYPH DAY"
                  value={fmtSignedUSDLocal(portfolioMetrics.cyphDailyChange)}
                  valueColor={signedColor(portfolioMetrics.cyphDailyChange)}
                />
                <MetaRow
                  label="ZEC DAY"
                  value={fmtSignedUSDLocal(portfolioMetrics.zecDailyChange)}
                  valueColor={signedColor(portfolioMetrics.zecDailyChange)}
                />
                <MetaRow
                  label="TOTAL DAY"
                  value={fmtSignedUSDLocal(portfolioMetrics.dailyChange)}
                  valueColor={signedColor(portfolioMetrics.dailyChange)}
                />
                <MetaRow
                  label="VS COST"
                  value={fmtSignedUSDLocal(portfolioMetrics.totalPnl)}
                  valueColor={signedColor(portfolioMetrics.totalPnl)}
                />
              </div>
            )}
          </CornerBox>
        </Link>
      </section>

      {/* ORDER FLOW — the roomy version of the tile depth strips. Tile
          columns are ~300px wide on desktop, which is not enough for the tape
          or the wall list, so this full-width section is where the same feed
          gets to stretch out. Off by default; toggled here (HIDE) or in
          Settings → ORDER DEPTH. Header chips swap ZEC aggregated depth for
          the CYPH live book. */}
      {settings.depthSection && (
        <div className="mb-2 md:mb-3">
          <DepthSection onHide={() => setSetting("depthSection", false)} />
        </div>
      )}

      {/* CHART + SUPPLY PANEL — desktop chart height kept in step with
          the condensed ZEC panel (mined/shielded + pools + rank +
          bitcoin). items-start avoids empty stretch bands while either
          side is still loading. */}
      <section className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-2 md:gap-3 mb-2 md:mb-3 items-start">
        <CornerBox
          label="PRICE OVERLAY"
          action={
            <span className="flex items-center gap-2 sm:gap-3">
              <span
                className="hidden sm:flex items-center gap-3 text-[11px]"
                style={{ color: paletteVar("text"), opacity: 0.7 }}
              >
                <span className="flex items-center gap-1">
                  <span
                    className="inline-block w-3 h-px"
                    style={{ background: paletteVar("cyph") }}
                  />
                  <span style={{ color: paletteVar("cyph") }}>{activePrimaryLabel}</span>
                </span>
                <span className="flex items-center gap-1">
                  <span
                    className="inline-block w-3 border-t border-dashed"
                    style={{ borderColor: paletteVar("zec") }}
                  />
                  <span style={{ color: paletteVar("zec") }}>ZEC</span>
                </span>
                <span className="flex items-center gap-1">
                  <span
                    className="inline-block w-3 border-t border-dotted"
                    style={{ borderColor: paletteVar("ratio") }}
                  />
                  <span style={{ color: paletteVar("ratio") }}>{activeRatioLabel}</span>
                </span>
              </span>
              <span
                className="relative inline-block"
                title={
                  chartPeriod === period
                    ? "Chart time window"
                    : "Chart time window (overrides global)"
                }
              >
                {chartPeriod !== period && (
                  <span
                    aria-hidden="true"
                    className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full"
                    style={{ background: paletteVar("ratio") }}
                  />
                )}
                <ETabs
                  items={PERIODS}
                  active={chartPeriod}
                  onChange={(next) =>
                    setChartPeriodOverride(next === period ? null : next)
                  }
                  compact
                />
              </span>
            </span>
          }
        >
          {/* Reserve the final responsive footprint before mounting the
              expensive SVG. useIsMobile starts at its SSR-safe desktop
              value, so rendering immediately made the chart paint at
              900x300 for one frame on mobile before shrinking to 360x180. */}
          <div
            className="h-[180px] overflow-hidden md:h-[300px]"
            aria-busy={!chartViewportReady}
          >
            {chartViewportReady && (
              <MultiLineChartE
                data={chartData}
                height={isMobile ? 180 : 300}
                viewBoxWidth={isMobile ? 360 : 900}
                primaryLabel={activePrimaryLabel}
                primaryValueFormat={
                  ratioMode === "btcZec"
                    ? (v) =>
                        "$" +
                        v.toLocaleString("en-US", {
                          maximumFractionDigits: 0,
                        })
                    : (v) => `$${v.toFixed(2)}`
                }
                ratioLabel={activeRatioLabel}
                ratioValueFormat={formatActiveRatio}
              />
            )}
          </div>
        </CornerBox>

        <CornerBox
          label="ZEC"
          action={
            <span className="inline-flex items-center gap-2">
              <Link
                href="/shielding"
                className="text-[11px] tracking-[0.2em] hover:underline transition-colors"
                style={{ color: paletteVar("ratio") }}
                title="Open shielding details"
              >
                SHIELDING -&gt;
              </Link>
              <Link
                href="/what-if"
                className="text-[11px] tracking-[0.2em] hover:underline transition-colors"
                style={{ color: paletteVar("ratio") }}
                title="What ZEC could be worth at different market shares"
              >
                WHAT IF -&gt;
              </Link>
            </span>
          }
        >
          {/* MINED + SHIELDED side-by-side to reclaim vertical room
              after the Bitcoin block was added below. */}
          {(circulating != null || shieldedPct != null) && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {circulating != null && (
                <div className="min-w-0">
                  <BlockProgress
                    pct={(circulating / 21e6) * 100}
                    width={12}
                    color={paletteVar("zec")}
                    label="MINED"
                    sub={`${((circulating / 21e6) * 100).toFixed(2)}%`}
                    animated={false}
                  />
                  <div
                    className="text-[10px] mt-0.5 truncate"
                    style={{ color: paletteVar("text"), opacity: 0.7 }}
                  >
                    {(circulating / 1e6).toFixed(2)}M / 21M
                  </div>
                </div>
              )}
              {shieldedPct != null && (
                <Link
                  href="/shielding"
                  className="min-w-0 block focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
                  style={{ outlineColor: paletteVar("ratio") }}
                  title="Open shielding details"
                >
                  <BlockProgress
                    pct={shieldedPct}
                    width={12}
                    color={paletteVar("ratio")}
                    label="SHIELDED"
                    sub={`${shieldedPct.toFixed(2)}%`}
                    animated={false}
                  />
                  {circulating != null && (
                    <div
                      className="text-[10px] mt-0.5 truncate"
                      style={{ color: paletteVar("text"), opacity: 0.7 }}
                    >
                      {(
                        ((circulating * shieldedPct) / 100) /
                        1e6
                      ).toFixed(2)}
                      M in pools
                    </div>
                  )}
                </Link>
              )}
            </div>
          )}
          {/* Ironwood migration totals. Replaced the Orchard prediction-market
              pill here — with Ironwood live, on-chain migration progress is the
              more relevant signal next to the pool figures above. The Orchard
              market still has its own page at /orchard-risk. */}
          {shieldedPct != null && (
            <div className="mt-1">
              <IronwoodTotalsPill />
            </div>
          )}
          {/* Per-pool breakdown — single-line chips so the row stays
              one tall as the other tile meta-chips. Only renders when
              at least one pool has a positive share.

              Five pools since Ironwood went live — it already holds more than
              SPROUT and LOCKBX combined, so listing those two while hiding it
              read as an omission. /stats shows the same five.

              3-up over two rows, not 5-up: this panel is 340px on desktop, so
              five in a row leaves ~62px per chip and "SPROUT 0.13%" needs ~82px
              — every label truncated. Second row carries the two legacy pools. */}
          {shielded && (shielded.ironwood + shielded.orchard + shielded.sapling + shielded.sprout + shielded.lockbox) > 0 && (
            <div className="mt-1 grid grid-cols-3 gap-1">
              {(() => {
                // Per-pool ZEC counts → percentage of chain supply,
                // matching the way the legacy stats client renders.
                const chain =
                  (shielded.transparent ?? 0) +
                  shielded.sprout +
                  shielded.sapling +
                  shielded.orchard +
                  shielded.ironwood +
                  shielded.lockbox
                const cells = [
                  ["IRONWD", shielded.ironwood, POOL_COLORS.ironwood],
                  ["ORCHRD", shielded.orchard, POOL_COLORS.orchard],
                  ["SAPLNG", shielded.sapling, POOL_COLORS.sapling],
                  ["SPROUT", shielded.sprout, POOL_COLORS.sprout],
                  ["LOCKBX", shielded.lockbox, POOL_COLORS.lockbox],
                ] as const
                return cells.map(([l, amt, c]) => {
                  const pct = chain > 0 ? (amt / chain) * 100 : 0
                  return (
                    <div
                      key={l}
                      className="flex h-5 w-full items-center justify-center gap-1 border px-1 text-[9px] font-bold leading-none tracking-[0.06em]"
                      style={{ borderColor: c + "55", color: c }}
                      title={`${l} · ${pct < 0.01 ? "<0.01" : pct.toFixed(2)}% of supply`}
                    >
                      <span className="truncate" style={{ opacity: 0.75 }}>
                        {l}
                      </span>
                      <span className="tabular-nums shrink-0">
                        {pct === 0
                          ? "0%"
                          : pct < 0.01
                            ? "<0.01%"
                            : pct < 1
                              ? pct.toFixed(2) + "%"
                              : pct.toFixed(1) + "%"}
                      </span>
                    </div>
                  )
                })
              })()}
            </div>
          )}
          {rankNeighbors.length > 0 && zecRank != null && (
            <div
              className="mt-1.5 pt-1.5"
              style={{ borderTop: `1px dashed ${paletteVar("text")}33` }}
            >
              {/* The whole block is one link rather than a link per row: every
                  row leads to the same place, and the rows already read as
                  clickable thanks to their hover highlight. `block` so the
                  grid rows inside keep laying out as they did. */}
              <Link
                href="/stats"
                className="group block"
                title="Open the full top-50 rankings"
                aria-label={`ZEC ranks #${zecRank} by market cap — open the full top-50 rankings`}
              >
                <div
                  className="mb-0.5 flex items-baseline gap-2 text-[10px] tracking-[0.3em]"
                  style={{ color: paletteVar("text"), opacity: 0.7 }}
                >
                  RANK NEIGHBORS
                  <span
                    aria-hidden="true"
                    className="ml-auto tracking-normal transition-transform group-hover:translate-x-0.5"
                  >
                    &rarr;
                  </span>
                </div>
                <div className="font-mono text-[11px] flex flex-col">
                  {rankNeighbors.map((r) => {
                    const isZec = r.symbol === "ZEC"
                    const c = isZec
                      ? paletteVar("zec")
                      : paletteVar("text")
                    return (
                      <div
                        key={r.symbol + r.rank}
                        className="grid grid-cols-[28px_16px_42px_1fr_auto] gap-1 items-center transition-colors hover:bg-emerald-950/30 px-1 py-px"
                        style={{ color: c, opacity: isZec ? 1 : 0.7 }}
                      >
                        <span>{isZec ? "►" : " "}#{r.rank}</span>
                        <CoinLogo image={r.image ?? null} symbol={r.symbol} size={14} />
                        <span className={isZec ? "font-bold" : ""}>{r.symbol}</span>
                        <span className="opacity-70 tabular-nums">
                          {fmtCompactUSD(r.marketCap)}
                        </span>
                        <span
                          className="tabular-nums"
                          style={{
                            color:
                              r.change24h != null
                                ? r.change24h >= 0
                                  ? paletteVar("cyph")
                                  : E_STATIC.red
                                : paletteVar("text"),
                          }}
                        >
                          {r.change24h != null
                            ? `${r.change24h >= 0 ? "+" : ""}${r.change24h.toFixed(1)}%`
                            : "—"}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </Link>
            </div>
          )}
          {/* BITCOIN — top-level BTC figures under RANK NEIGHBORS.
              Header + price share one band; meta stays 2×2. */}
          {btcPrice != null && (
            <div
              className="mt-1.5 pt-1.5"
              style={{ borderTop: `1px dashed ${paletteVar("text")}33` }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span
                    className="text-[10px] tracking-[0.3em]"
                    style={{ color: paletteVar("ratio") }}
                  >
                    BITCOIN
                  </span>
                  <span
                    className="text-[15px] font-bold tabular-nums leading-none"
                    style={{ color: paletteVar("ratio") }}
                  >
                    {"$" +
                      btcPrice.toLocaleString("en-US", {
                        maximumFractionDigits: 0,
                      })}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <PerfBadge value={btcChange24h} label="24H" />
                  <Link
                    href="/bitcoin"
                    className="text-[10px] tracking-[0.16em] transition-colors hover:underline"
                    style={{ color: paletteVar("ratio") }}
                    title="Open BTC vs ZEC stats"
                  >
                    BTC -&gt;
                  </Link>
                </div>
              </div>
              <div className="mt-0.5 grid grid-cols-2 gap-x-3 text-[11px]">
                <MetaRow label="MCAP" value={fmtCompactUSD(btcMarketCap)} />
                <MetaRow
                  label="SATS/ZEC"
                  value={
                    satsPerZec != null
                      ? fmtCompactNumberLocal(satsPerZec)
                      : "—"
                  }
                />
                <MetaRow
                  label="MINED"
                  value={btcMined != null ? btcMined.toFixed(2) + "%" : "—"}
                />
                <MetaRow
                  label="ZEC/BTC"
                  value={zecBtcRatio != null ? zecBtcRatio.toFixed(6) : "—"}
                />
              </div>
            </div>
          )}
        </CornerBox>
      </section>

      {/* TOOLS — single-line nav tiles (no subtitle). 2×2 on mobile /
          tablet, one row of four on desktop. */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-3">
        {[
          { href: "/estimator", t: "ESTIMATOR", c: paletteVar("cyph") },
          { href: "/portfolio", t: "PORTFOLIO", c: paletteVar("ratio") },
          { href: "/shielding", t: "SHIELDING", c: paletteVar("ratio") },
        ].map((cta) => (
          <Link key={cta.href} href={cta.href} className="block group h-full">
            <CornerBox color={cta.c} interactive className="h-full">
              <div className="flex items-center gap-2 min-h-[1.75rem]">
                <div
                  className="font-bold text-[12px] tracking-[0.2em]"
                  style={{ color: cta.c }}
                >
                  {cta.t}
                </div>
                <span className="ml-auto" style={{ color: cta.c }}>
                  →
                </span>
              </div>
            </CornerBox>
          </Link>
        ))}
        {/* STATS — title + ZEC/BTC jump chips on one row so this tile
            matches the single-line height of the other three. */}
        <div className="h-full">
          <CornerBox color={paletteVar("zec")} className="h-full">
            <div className="flex items-center gap-2 min-h-[1.75rem]">
              <div
                className="font-bold text-[12px] tracking-[0.2em] shrink-0"
                style={{ color: paletteVar("zec") }}
              >
                STATS
              </div>
              <div className="ml-auto grid grid-cols-2 gap-1 min-w-0">
                <Link
                  href="/stats"
                  className="group flex items-center justify-between border px-1.5 py-0.5 text-[10px] font-bold tracking-[0.12em] transition-colors hover:bg-white/5"
                  style={{
                    color: paletteVar("zec"),
                    borderColor: withAlpha(paletteVar("zec"), 45),
                  }}
                  title="Open ZEC stats"
                >
                  ZEC
                  <span className="transition-transform group-hover:translate-x-0.5">→</span>
                </Link>
                <Link
                  href={`/stats?view=${DEPTH_STATS_VIEW}`}
                  className="group flex items-center justify-between border px-1.5 py-0.5 text-[10px] font-bold tracking-[0.12em] transition-colors hover:bg-white/5"
                  style={{
                    color: paletteVar("cyph"),
                    borderColor: withAlpha(paletteVar("cyph"), 45),
                  }}
                  title="Open aggregated order-book depth, tape and price action"
                >
                  FLOW
                  <span className="transition-transform group-hover:translate-x-0.5">→</span>
                </Link>
                <Link
                  href="/bitcoin"
                  className="group flex items-center justify-between border px-1.5 py-0.5 text-[10px] font-bold tracking-[0.12em] transition-colors hover:bg-white/5"
                  style={{
                    color: paletteVar("ratio"),
                    borderColor: withAlpha(paletteVar("ratio"), 45),
                  }}
                  title="Open BTC vs ZEC stats"
                >
                  BTC
                  <span className="transition-transform group-hover:translate-x-0.5">→</span>
                </Link>
              </div>
            </div>
          </CornerBox>
        </div>
      </section>

      {/* FOOTER — PWA install, PiP pop-out, ABOUT link, and data
          attribution. PWA chip only appears on browsers with a
          deferrable install prompt (Chrome / Edge / Brave) or iOS
          Safari; PiP chip only on browsers exposing the Document PiP
          or HTMLVideoElement PiP API. Both wrap the production-grade
          components from the legacy site, rewrapped in the E theme
          via `components/footer-buttons.tsx`. */}
      <footer className="mt-3 flex flex-wrap items-center gap-2 px-1">
        <PwaInstall />
        <PipPopout />
        <Link
          href="/about"
          className="px-2 py-1 text-[11px] tracking-[0.2em] font-bold transition-colors hover:bg-emerald-950/40 inline-flex items-center gap-1.5"
          style={{
            color: paletteVar("text"),
            opacity: 0.8,
            border: `1px solid ${paletteVar("text")}33`,
          }}
        >
          ABOUT · FAQ
        </Link>
        <Link
          href="/donate"
          className="px-2 py-1 text-[11px] tracking-[0.2em] font-bold transition-colors hover:bg-emerald-950/40 inline-flex items-center gap-1.5"
          style={{
            color: paletteVar("text"),
            opacity: 0.8,
            border: `1px solid ${paletteVar("text")}33`,
          }}
        >
          DONATE
        </Link>
        <span
          className="text-[11px] ml-auto"
          style={{ color: paletteVar("text"), opacity: 0.4 }}
        >
          data: yahoo · kraken · coingecko · coinmarketcap · cipherscan · cypherpunk.com
        </span>
      </footer>
    </>
  )
}

// ──────────────────────────────────────────────────────────────────────
// Tiny helpers — only used within this file so they live alongside.
// ──────────────────────────────────────────────────────────────────────
function RatioModeToggle({
  value,
  onChange,
}: {
  value: RatioMode
  onChange: (v: RatioMode) => void
}) {
  const options: { value: RatioMode; label: string; title: string }[] = [
    { value: "cyphZec", label: "CYPH", title: "Show CYPH/ZEC ratio" },
    { value: "btcZec", label: "BTC", title: "Show ZEC/BTC ratio" },
  ]
  return (
    <div
      className="box-border inline-flex items-stretch overflow-hidden border text-[9px] font-bold leading-none tracking-[0.1em]"
      style={{
        borderColor: `${paletteVar("ratio")}55`,
        height: 18,
        minHeight: 18,
        maxHeight: 18,
      }}
      aria-label="Ratio mode"
    >
      {options.map((option, i) => {
        const active = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            title={option.title}
            aria-pressed={active}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onChange(option.value)
            }}
            className="inline-flex items-center justify-center px-1.5 leading-none transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
            style={{
              height: 16,
              minHeight: 0,
              paddingTop: 0,
              paddingBottom: 0,
              lineHeight: 1,
              color: active ? "#000" : paletteVar("ratio"),
              background: active ? paletteVar("ratio") : "transparent",
              outlineColor: paletteVar("ratio"),
              opacity: active ? 1 : 0.75,
              borderLeft:
                i > 0 ? `1px solid ${paletteVar("ratio")}55` : undefined,
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** Single-line perf readout so tile headers keep title + chips + % on
 *  one row (▲ 9.22% 24H). Stacked value/label was wrapping the 24H
 *  under the chips on narrow / 4-tile layouts. */
function PerfBadge({
  value,
  label,
}: {
  value: number | null | undefined
  label: string
}) {
  const ok = value != null && Number.isFinite(value)
  // Values smaller than half a basis-point round to "0.00%" in display,
  // so colouring + arrowing them as up/down lies to the user. Treat
  // that range as flat: neutral colour, no arrow.
  const flat = ok && Math.abs(value) < 0.005
  const color =
    !ok || flat
      ? paletteVar("text")
      : value >= 0
        ? paletteVar("cyph")
        : E_STATIC.red
  return (
    <div
      className="inline-flex shrink-0 items-center gap-1 text-[10px] leading-none tabular-nums whitespace-nowrap"
      style={{ opacity: !ok ? 0.5 : flat ? 0.7 : 1 }}
      title={ok && !flat ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}% ${label}` : label}
    >
      <span className="font-bold" style={{ color }}>
        {!ok
          ? "—"
          : flat
            ? "0.00%"
            : `${value >= 0 ? "▲" : "▼"}${Math.abs(value).toFixed(2)}%`}
      </span>
      <span style={{ color: paletteVar("text"), opacity: 0.5 }}>{label}</span>
    </div>
  )
}

function NavCell({
  label,
  value,
  format,
  color,
  icon,
  note,
}: {
  label: string
  value: number | null
  format: (v: number) => string
  color: string
  icon?: React.ReactNode
  note?: string
}) {
  // Cell dividers are drawn on the parent grid via gap-px + a
  // matching background tint, so NavCell carries no border of its
  // own — that's what was causing the visible double-line at the
  // rightmost cell flush against the row's outer border.
  return (
    <div
      className="px-2 py-1.5 text-center"
      style={{ background: `${color}0c` }}
    >
      <div
        className="text-[10px] tracking-wider inline-flex items-center justify-center gap-1 leading-none"
        style={{ color: paletteVar("text"), opacity: 0.7 }}
      >
        {icon && (
          <span
            className="inline-flex items-center"
            style={{ color }}
          >
            {icon}
          </span>
        )}
        <span>{label}</span>
      </div>
      <div
        className="text-[14px] font-bold tabular-nums leading-tight mt-1"
        style={{ color }}
      >
        <LiveNumber value={value} format={format} color={color} />
      </div>
      {note && (
        <div
          className="mt-0.5 text-[9px] leading-none"
          style={{ color: paletteVar("text"), opacity: 0.45 }}
        >
          {note}
        </div>
      )}
    </div>
  )
}

// One column of the CYPH tile's NAV-per-share row: the NAV/share value
// over its signed discount/premium vs the live price (− = below NAV,
// + = above). Deliberately distinct from mNAV so the two aren't conflated.
function NavShareCell({
  label,
  nav,
  vsNavPct,
}: {
  label: string
  nav: number | null
  vsNavPct: number | null
}) {
  const vsColor =
    vsNavPct == null
      ? paletteVar("text")
      : vsNavPct >= 0
        ? paletteVar("cyph")
        : E_STATIC.red
  return (
    <div
      className="px-2 py-1.5 text-center"
      style={{ background: `${paletteVar("amber")}0c` }}
    >
      <div
        className="text-[10px] tracking-wider leading-none"
        style={{ color: paletteVar("text"), opacity: 0.7 }}
      >
        {label}
      </div>
      <div
        className="mt-1 text-[15px] font-bold tabular-nums leading-none"
        style={{ color: paletteVar("amber") }}
      >
        <LiveNumber
          value={nav}
          format={(v) => "$" + v.toFixed(2)}
          color={paletteVar("amber")}
        />
      </div>
      <div
        className="mt-1 text-[10px] tabular-nums leading-none"
        style={{ color: vsColor, opacity: vsNavPct == null ? 0.5 : 1 }}
      >
        {vsNavPct != null
          ? `${vsNavPct >= 0 ? "+" : ""}${vsNavPct.toFixed(0)}% vs NAV`
          : "vs NAV --"}
      </div>
    </div>
  )
}

// Inline "LABEL value" chip for the CYPH valuation traceability row.
function TraceStat({
  label,
  value,
  color,
}: {
  label: string
  value: string
  color: string
}) {
  return (
    <span className="whitespace-nowrap">
      <span style={{ color: paletteVar("text"), opacity: 0.5 }}>{label}</span>{" "}
      <span className="font-bold tabular-nums" style={{ color }}>
        {value}
      </span>
    </span>
  )
}

function MetaRow({
  label,
  value,
  active = false,
  activeColor,
  valueColor: valueColorOverride,
}: {
  label: React.ReactNode
  value: string
  active?: boolean
  activeColor?: string
  valueColor?: string
}) {
  // When `active` is true, the row is the session sourcing the
  // current headline price. Render a soft tint + leading dot so the
  // user can trace the big number back to its session at a glance.
  // aria-label below covers screen-readers — the dot is purely
  // decorative, the prose ("current session — $1.21") carries the
  // meaning.
  const valueColor =
    valueColorOverride ??
    (active ? activeColor ?? paletteVar("text") : paletteVar("text"))
  return (
    <div
      className="flex items-center justify-between py-1"
      style={{
        borderBottom: `1px dotted ${paletteVar("text")}22`,
        background: active && activeColor ? `${activeColor}10` : undefined,
      }}
    >
      <span
        className="inline-flex items-center gap-1 leading-none"
        style={{ color: paletteVar("text"), opacity: 0.6 }}
      >
        {active && activeColor && (
          <span
            aria-hidden="true"
            className="inline-block rounded-full shrink-0"
            style={{
              width: 4,
              height: 4,
              background: activeColor,
              boxShadow: `0 0 4px ${activeColor}`,
            }}
          />
        )}
        <span className="inline-flex items-center gap-1">{label}</span>
      </span>
      <span className="font-bold tabular-nums" style={{ color: valueColor }}>
        {value}
      </span>
    </div>
  )
}

function fmtCompactNumberLocal(n: number): string {
  if (!Number.isFinite(n)) return "—"
  const abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B"
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M"
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + "K"
  return n.toFixed(0)
}
