"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { usePersistentState } from "@/lib/use-persistent-state"
import {
  CoinLogo,
  CornerBox,
  BlockProgress,
  MultiLineChartE,
  SimpleLineChartE,
  StackedAreaChart,
  WindowChips,
  useIsMobile,
  type ChartWindow,
  windowSliceDays,
} from "./primitives"
import { paletteVar, E_STATIC } from "./theme"
import { fmtCompactUSD, fmtPriceCompact, swrFetcher } from "./format"
import {
  ZEC_MAX_SUPPLY,
  getZecEmissionCurve,
  type EmissionPoint,
} from "@/lib/zec-emission"
import { ShareButton } from "./share-button"
import { ExchangesTab } from "./exchanges-tab"
import { OrderFlowPanels } from "./order-depth"
import {
  DEPTH_STATS_VIEW,
  SECTION_DEFAULT_VIEW,
  ZEC_SECTIONS,
  ZEC_SECTION_LABELS,
  isZecView,
  sectionViews,
  viewLabel,
  viewSection,
  type ZecSection,
  type ZecView,
} from "./zec-views"
import { IronwoodAtGlance } from "./ironwood"
import { PowerLawRainbow } from "./power-law-rainbow"
import type {
  MarketCoin,
  MarketsResponse,
  PricesResponse,
  ZecStatsResponse,
} from "./api-types"

// Rankings can be metric-toggled between market cap (= price ×
// circulating supply, the default) and FDV (= price × max/total
// supply, "where would this rank if every token ever was already
// trading"). When FDV is on, the table re-sorts + re-numbers ranks
// locally so the # column matches whatever value's being displayed
// in the MCAP column.
type RankMetric = "marketCap" | "fdv"

function rankValue(c: MarketCoin, metric: RankMetric): number | null {
  if (metric === "fdv") return c.fdv ?? c.marketCap
  return c.marketCap
}

const POOL_COLORS = {
  ironwood: "#f6c945",
  orchard: "#7dd3fc",
  sapling: "#67e8f9",
  sprout: "#22d3ee",
  lockbox: "#a78bfa",
} as const

function formatEmissionDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(new Date(`${date}T00:00:00Z`))
    .toUpperCase()
}

function EmissionCurveChart({
  data,
  height,
  viewBoxWidth,
}: {
  data: EmissionPoint[]
  height: number
  viewBoxWidth: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  const w = viewBoxWidth
  const padding = { l: w < 500 ? 42 : 68, r: w < 500 ? 18 : 24, t: 8, b: 28 }
  const innerW = Math.max(50, w - padding.l - padding.r)
  const innerH = height - padding.t - padding.b
  const c = paletteVar("zec")
  const textCol = paletteVar("text")
  const series = data.filter((p) => Number.isFinite(p.supply))
  const times = series.map((p) => Date.parse(`${p.date}T00:00:00Z`))
  const minT = times[0] ?? 0
  const maxT = times[times.length - 1] ?? minT + 1
  const spanT = maxT - minT || 1
  const scaleX = (ms: number) => padding.l + ((ms - minT) / spanT) * innerW
  const scaleY = (supply: number) =>
    padding.t + (1 - Math.min(ZEC_MAX_SUPPLY, supply) / ZEC_MAX_SUPPLY) * innerH
  const path = series
    .map((p, i) => {
      const x = scaleX(times[i])
      const y = scaleY(p.supply)
      return `${i === 0 ? "M" : "L"}${x},${y}`
    })
    .join(" ")
  const areaPath = `${path} L${scaleX(maxT)},${padding.t + innerH} L${scaleX(minT)},${padding.t + innerH} Z`
  const todayIdx = series.findIndex((p) => p.today)
  const today = todayIdx >= 0 ? series[todayIdx] : null
  const todayX = today ? scaleX(times[todayIdx]) : null
  const todayY = today ? scaleY(today.supply) : null
  const hoverIdx = hover ?? todayIdx
  const hoverPoint = hoverIdx >= 0 ? series[hoverIdx] : today
  const hoverX = hoverIdx >= 0 ? scaleX(times[hoverIdx]) : todayX
  const hoverY = hoverIdx >= 0 ? scaleY(series[hoverIdx].supply) : todayY
  const tickCount = w < 500 ? 4 : 6
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const t = i / (tickCount - 1)
    return { ms: minT + t * spanT, i, last: i === tickCount - 1 }
  })

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * w
    const t = minT + ((x - padding.l) / innerW) * spanT
    let best = 0
    let dist = Infinity
    times.forEach((ms, i) => {
      const next = Math.abs(ms - t)
      if (next < dist) {
        dist = next
        best = i
      }
    })
    setHover(best)
  }

  if (series.length < 2) {
    return (
      <div
        className="flex items-center justify-center font-mono text-[11px]"
        style={{ height, color: paletteVar("text"), opacity: 0.6 }}
      >
        Loading emission curve...
      </div>
    )
  }

  return (
    <svg
      role="img"
      aria-label="ZEC emission curve from genesis to max supply"
      viewBox={`0 0 ${w} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      style={{ filter: `drop-shadow(0 0 4px ${c}44)`, overflow: "visible" }}
    >
      <defs>
        <linearGradient id="zec-emission-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c} stopOpacity="0.28" />
          <stop offset="100%" stopColor={c} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <line
          key={t}
          x1={padding.l}
          y1={padding.t + t * innerH}
          x2={w - padding.r}
          y2={padding.t + t * innerH}
          stroke={textCol}
          strokeOpacity={0.12}
          strokeDasharray="1 4"
        />
      ))}
      <line
        x1={padding.l}
        y1={padding.t}
        x2={w - padding.r}
        y2={padding.t}
        stroke={c}
        strokeOpacity={0.55}
        strokeDasharray="4 4"
      />
      <path d={areaPath} fill="url(#zec-emission-fill)" />
      <path d={path} fill="none" stroke={c} strokeWidth={1.8} />
      <text
        x={padding.l - 8}
        y={padding.t + 4}
        textAnchor="end"
        fontSize="12"
        fill={c}
        fontFamily="ui-monospace, monospace"
      >
        21.00M
      </text>
      <text
        x={padding.l - 8}
        y={padding.t + innerH}
        textAnchor="end"
        fontSize="12"
        fill={c}
        fontFamily="ui-monospace, monospace"
      >
        0.00M
      </text>
      {ticks.map(({ ms, i, last }) => (
        <g key={i}>
          <line
            x1={scaleX(ms)}
            y1={padding.t}
            x2={scaleX(ms)}
            y2={padding.t + innerH}
            stroke={textCol}
            strokeOpacity={0.08}
          />
          <text
            x={scaleX(ms)}
            y={height - 7}
            textAnchor={i === 0 ? "start" : last ? "end" : "middle"}
            fontSize={w < 500 ? 10 : 11}
            fontFamily="ui-monospace, monospace"
            fill={textCol}
            fillOpacity={0.62}
          >
            {formatEmissionDate(new Date(ms).toISOString().slice(0, 10))}
          </text>
        </g>
      ))}
      {today && todayX != null && todayY != null && (
        <g>
          <line
            x1={todayX}
            y1={padding.t}
            x2={todayX}
            y2={padding.t + innerH}
            stroke={E_STATIC.red}
            strokeOpacity={0.75}
            strokeDasharray="3 3"
          />
          <circle cx={todayX} cy={todayY} r={4} fill={E_STATIC.red} />
        </g>
      )}
      {hoverPoint && hoverX != null && hoverY != null && (
        <g>
          <line
            x1={hoverX}
            y1={padding.t}
            x2={hoverX}
            y2={padding.t + innerH}
            stroke={hoverPoint.today ? E_STATIC.red : c}
            strokeOpacity={0.55}
            strokeDasharray="2 2"
          />
          <circle
            cx={hoverX}
            cy={hoverY}
            r={3.5}
            fill={hoverPoint.today ? E_STATIC.red : c}
          />
          <g
            transform={`translate(${Math.min(Math.max(hoverX + 10, padding.l), w - padding.r - 156)}, ${padding.t + 8})`}
          >
            <rect
              width="156"
              height="48"
              fill="#000"
              stroke={hoverPoint.today ? E_STATIC.red : c}
              strokeOpacity={0.7}
            />
            <text
              x={7}
              y={15}
              fontSize="11"
              fontFamily="ui-monospace, monospace"
              fill={textCol}
              fillOpacity={0.75}
            >
              {hoverPoint.today ? "TODAY" : formatEmissionDate(hoverPoint.date)}
            </text>
            <text
              x={7}
              y={31}
              fontSize="13"
              fontFamily="ui-monospace, monospace"
              fill={hoverPoint.today ? E_STATIC.red : c}
            >
              ZEC {(hoverPoint.supply / 1e6).toFixed(2)}M
            </text>
            <text
              x={7}
              y={43}
              fontSize="10"
              fontFamily="ui-monospace, monospace"
              fill={textCol}
              fillOpacity={0.55}
            >
              MAX 21.00M
            </text>
          </g>
        </g>
      )}
    </svg>
  )
}

// The section strip and every sub-strip come from `./zec-views`, which also
// owns the `?view=` contract — see that module for why the views are split
// across four sections rather than one long strip.

// Per-pool history endpoint already exposes daily snapshots of the
// shielded supply by pool — see `/api/zec-stats/history` and the
// existing `<SupplyCharts>` consumer. We reuse the same shape here so
// the StackedAreaChart can plot the real numbers.
interface ShieldedHistoryPoint {
  date: string
  total: number
  sapling: number
  orchard: number
  ironwood: number
  sprout: number
}
interface ShieldedHistoryResponse {
  points: ShieldedHistoryPoint[]
  daysCollected: number
}

interface TxDay {
  date: string
  total: number
  transparentOnly: number
  shielding: number
  deshielding: number
  fullyShielded: number
  mixed: number
}
interface TxStatsResponse {
  days: TxDay[]
  latestDate: string | null
  dataLagDays: number | null
  source?: {
    total: string
    shielded: string
  }
  fetchedAt: number
  stale?: boolean
}

function chartDateLabel(date: string, includeYear = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  return includeYear ? `${m[1].slice(2)}-${m[2]}-${m[3]}` : `${m[2]}-${m[3]}`
}

function readableDate(date: string | null | undefined): string {
  if (!date) return "unknown"
  const ms = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(ms)) return date
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })
}

export function Stats() {
  const [section, setSection] = useState<ZecSection>("rankings")
  const [view, setView] = useState<ZecView>("supply")
  const subViews = sectionViews(section)

  // `?view=` names a leaf, and the section follows from it — so a link written
  // before the views were split across sections still lands in the right
  // place without a redirect table.
  useEffect(() => {
    const deepLink = new URLSearchParams(window.location.search).get("view")
    if (isZecView(deepLink)) {
      setSection(viewSection(deepLink))
      setView(deepLink)
    }
  }, [])

  /** Tabbing into a section opens its default view — unless the remembered
   *  view already belongs there, in which case going RANKINGS → back returns
   *  you to the sub-tab you left rather than resetting to the default. */
  const openSection = (next: ZecSection) => {
    setSection(next)
    const fallback = SECTION_DEFAULT_VIEW[next]
    if (fallback && viewSection(view) !== next) setView(fallback)
  }

  // The leaf that is actually on screen. RANKINGS has no default view, so
  // `view` keeps whatever leaf you were last on while you are in that
  // section — meaning a leaf id on its own does NOT imply its content is
  // rendered. Gating the lazy fetches on the id alone made a plain /stats
  // load pull the per-pool history for a SUPPLY tab nobody had opened, and
  // kept it refreshing after tabbing back to RANKINGS.
  const activeView: ZecView | null =
    viewSection(view) === section ? view : null

  useEffect(() => {
    // Deep links (/stats?view=rainbow#rainbow) select a sub-view that isn't in
    // the initial rankings render, so the browser can't honor the hash on
    // load — scroll once the panel has mounted.
    const anchor = window.location.hash.slice(1)
    if (anchor !== "rainbow" || view !== anchor) return
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ block: "start" })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [view])
  // 360-wide viewBox on mobile keeps SVG axis labels from squishing
  // horizontally; desktop's 900 default already fits the wide chart
  // card so we leave that alone.
  const isMobile = useIsMobile()
  const chartW = isMobile ? 360 : 900
  // Per-chart window selection. Each chart owns its own state so the
  // user can pin SHIELDED CHART to 1Y while keeping TRANSACTIONS on
  // 30D, etc. Defaults are 90D so the first view matches the
  // previous behaviour.
  const [shieldedChartWindow, setShieldedChartWindow] =
    useState<ChartWindow>("90D")
  const [txWindow, setTxWindow] = useState<ChartWindow>("90D")

  // Rankings table toggles — both persisted so the user's preference
  // survives a refresh, both default to the "plain" reading (MCAP +
  // $ delta) to match the original beta behaviour. Storage keys
  // match the legacy /stats page so a user landing on either surface
  // sees a single consistent setting.
  const [fdvOn, setFdvOn] = usePersistentState<boolean>(
    "cyphzec.stats.fdv",
    false,
    (v): v is boolean => typeof v === "boolean"
  )
  const [showPct, setShowPct] = usePersistentState<boolean>(
    "cyphzec.stats.showPct",
    false,
    (v): v is boolean => typeof v === "boolean"
  )
  const metric: RankMetric = fdvOn ? "fdv" : "marketCap"

  const { data: markets } = useSWR<MarketsResponse>("/api/markets", swrFetcher, {
    refreshInterval: 5 * 60_000,
    keepPreviousData: true,
  })
  const { data: zecStats } = useSWR<ZecStatsResponse>(
    "/api/zec-stats",
    swrFetcher,
    {
      refreshInterval: 5 * 60_000,
      keepPreviousData: true,
    }
  )
  const { data: prices90 } = useSWR<PricesResponse>(
    "/api/prices?days=90",
    swrFetcher,
    {
      refreshInterval: 5 * 60_000,
      keepPreviousData: true,
    }
  )
  // Per-pool history + daily-tx stats lazy-load only once the view that needs
  // them is actually on screen — keeps the cold-load round trips on RANKINGS
  // down to the leaderboard fetch.
  const { data: shieldedHistory } = useSWR<ShieldedHistoryResponse>(
    activeView === "shieldedChart" ||
    activeView === "shielded" ||
    activeView === "supply"
      ? "/api/zec-stats/history"
      : null,
    swrFetcher,
    { refreshInterval: 30 * 60_000, keepPreviousData: true }
  )
  const { data: txStats } = useSWR<TxStatsResponse>(
    activeView === "transactions" ? "/api/zec-tx-stats" : null,
    swrFetcher,
    { refreshInterval: 30 * 60_000, keepPreviousData: true }
  )

  // When FDV is on we re-sort the upstream's mcap-ordered list by FDV
  // and re-number ranks 1..N so the # column matches the displayed
  // value. With the toggle off we keep CMC's ordering unchanged.
  // Stable secondary sort by symbol keeps rows from jittering when
  // two coins have effectively-equal FDV.
  const rawCoins = markets?.coins ?? []
  const coins = useMemo<MarketCoin[]>(() => {
    if (!fdvOn) return rawCoins
    const sorted = [...rawCoins].sort((a, b) => {
      const av = rankValue(a, "fdv") ?? -Infinity
      const bv = rankValue(b, "fdv") ?? -Infinity
      if (bv !== av) return bv - av
      return a.symbol.localeCompare(b.symbol)
    })
    return sorted.map((c, i) => ({ ...c, rank: i + 1 }))
  }, [rawCoins, fdvOn])

  const zecCoin = coins.find((c) => c.symbol === "ZEC")
  const zecRank = zecCoin?.rank ?? zecStats?.rank ?? null
  const zecMcap = zecCoin ? rankValue(zecCoin, metric) ?? zecStats?.marketCap ?? null : zecStats?.marketCap ?? null
  const zecPrice = zecCoin?.price ?? zecStats?.price ?? null
  // Prefer /api/zec-stats circulating (cipherscan on-chain chainSupply, the
  // freshest mined figure); fall back to the leaderboard's circulating only
  // when zec-stats is unavailable.
  const zecSupply = zecStats?.circulating ?? zecCoin?.circulatingSupply ?? null
  const nextCoin =
    zecRank != null ? coins.find((c) => c.rank === zecRank - 1) : null
  const deltaToNextPrice =
    nextCoin != null && zecMcap != null && zecSupply != null && zecSupply > 0
      ? (() => {
          const nv = rankValue(nextCoin, metric)
          return nv != null ? (nv - zecMcap) / zecSupply : null
        })()
      : null
  const shielded = zecStats?.shieldedBreakdown ?? null
  const shieldedPct = zecStats?.shieldedPct ?? shielded?.pct ?? null

  // Per-pool history, normalized for the chart components. The realtime
  // snapshot replaces today's daily point so the fast-moving Ironwood
  // migration does not wait for the next zecprice regeneration.
  const shieldedAllPoints = useMemo(() => {
    const pts = [...(shieldedHistory?.points ?? [])]
    if (shielded) {
      const today = new Date().toISOString().slice(0, 10)
      const current: ShieldedHistoryPoint = {
        date: today,
        total: shielded.total,
        orchard: shielded.orchard,
        ironwood: shielded.ironwood,
        sapling: shielded.sapling,
        sprout: shielded.sprout,
      }
      if (pts.at(-1)?.date === today) pts[pts.length - 1] = current
      else pts.push(current)
    }
    return pts.map((p) => ({
      date: p.date.slice(5),
      // Carried through for OVERVIEW's trend line, which has to plot the
      // same quantity the headline shows (upstream's shielded total,
      // lockbox included) rather than the sum of the four charted pools —
      // otherwise the two numbers sit side by side and disagree.
      // StackedAreaChart takes explicit `keys`, so this extra field is inert
      // there.
      total: p.total ?? 0,
      orchard: p.orchard ?? 0,
      ironwood: p.ironwood ?? 0,
      sapling: p.sapling ?? 0,
      sprout: p.sprout ?? 0,
    }))
  }, [shielded, shieldedHistory])
  // Theoretical Zcash mining-emission curve (total issued supply).
  // Generated locally from the known block-subsidy schedule.
  const emissionAllPoints = useMemo(() => getZecEmissionCurve(), [])

  // OVERVIEW's fixed 90-day trend. Deliberately independent of the CHART
  // tab's window selector — see the comment at its render site.
  const shieldedTrendPoints = useMemo(
    // Drop points the upstream had no total for, rather than plotting them
    // as a dive to zero.
    () => shieldedAllPoints.filter((p) => p.total > 0).slice(-90),
    [shieldedAllPoints]
  )
  const shieldedTrendDelta = useMemo(() => {
    if (shieldedTrendPoints.length < 2) return null
    const first = shieldedTrendPoints[0].total
    const last = shieldedTrendPoints[shieldedTrendPoints.length - 1].total
    if (!Number.isFinite(first) || !Number.isFinite(last)) return null
    return (last - first) / 1e6
  }, [shieldedTrendPoints])

  const shieldedChartPoints = useMemo(() => {
    const days = windowSliceDays(shieldedChartWindow)
    return days == null
      ? shieldedAllPoints
      : shieldedAllPoints.slice(-days)
  }, [shieldedAllPoints, shieldedChartWindow])

  // Tx-stats — anything that touches a shielded pool (shielding,
  // deshielding, fully-shielded, mixed) counts as "shielded" since
  // that's what users actually mean when they ask "how many shielded
  // txs?". Sliced by the per-tab window below.
  const txLatestDate =
    txStats?.latestDate ?? txStats?.days.at(-1)?.date ?? null
  const txDataLagDays =
    txStats?.dataLagDays ??
    (() => {
      if (!txLatestDate) return null
      const latestMs = Date.parse(`${txLatestDate}T00:00:00Z`)
      const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)
      return Number.isFinite(latestMs) && Number.isFinite(todayMs)
        ? Math.max(0, Math.floor((todayMs - latestMs) / 86_400_000))
        : null
    })()
  const txDataStale = txDataLagDays != null && txDataLagDays > 2
  const txForceYear =
    txDataStale ||
    (txLatestDate != null &&
      txLatestDate.slice(0, 4) !== new Date().getUTCFullYear().toString())
  const txAllPoints = useMemo(() => {
    const days = txStats?.days ?? []
    return days.map((d) => ({
      date: chartDateLabel(d.date, txForceYear),
      sourceDate: d.date,
      total: d.total,
      shielded:
        d.shielding + d.deshielding + d.fullyShielded + d.mixed,
    }))
  }, [txForceYear, txStats])
  const txPoints = useMemo(() => {
    const days = windowSliceDays(txWindow)
    return days == null ? txAllPoints : txAllPoints.slice(-days)
  }, [txAllPoints, txWindow])

  // Latest tx day for the shielded-ratio summary tile. Fall back to
  // null when no data has loaded yet — the tile renders an em-dash.
  const lastTx = txPoints.length > 0 ? txPoints[txPoints.length - 1] : null
  const lastShieldedRatio =
    lastTx && lastTx.total > 0 ? (lastTx.shielded / lastTx.total) * 100 : null

  return (
    <>
      <div className="flex justify-end mb-2">
        <ShareButton
          tweetText="$ZEC live rank + market stats — leaderboard, shielded supply, daily tx:"
          ogImagePath="/api/og/stats"
          pngFileName="zec-stats.png"
          shareUrl="https://cyphzec.com/stats"
          xCacheBust
          ariaLabel="Share ZEC stats"
        />
      </div>

      {/* Highlight banner — only when we have ZEC data to highlight */}
      {zecRank != null && (
        <CornerBox color={paletteVar("zec")} className="mb-3">
          <div className="grid grid-cols-1 md:grid-cols-[auto_1fr_auto] items-center gap-4">
            <div
              className="font-bold text-3xl tabular-nums"
              style={{
                color: paletteVar("zec"),
                textShadow: `0 0 8px ${paletteVar("zec")}55`,
              }}
            >
              #{zecRank}
            </div>
            <div>
              <div
                className="text-[11px] tracking-[0.3em]"
                style={{ color: paletteVar("text"), opacity: 0.6 }}
              >
                ZCASH · ZEC
              </div>
              <div className="text-xl font-bold tabular-nums">
                {fmtCompactUSD(zecMcap)}{" "}
                <span
                  className="text-[11px]"
                  style={{ color: paletteVar("text"), opacity: 0.6 }}
                >
                  {fdvOn ? "FDV" : "market cap"}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] md:grid-cols-3">
              {nextCoin && deltaToNextPrice != null && (
                <div
                  className="px-2 py-1 border"
                  style={{ borderColor: `${paletteVar("cyph")}55` }}
                >
                  <div
                    className="text-[10px]"
                    style={{ color: paletteVar("text"), opacity: 0.6 }}
                  >
                    FLIP {nextCoin.symbol}
                  </div>
                  <div
                    className="font-bold tabular-nums"
                    style={{ color: paletteVar("cyph") }}
                  >
                    +${deltaToNextPrice.toFixed(2)}
                  </div>
                </div>
              )}
              {shieldedPct != null && (
                <Link
                  href="/shielding"
                  className="block px-2 py-1 border"
                  style={{ borderColor: `${paletteVar("ratio")}55` }}
                  title="Open shielding details"
                >
                  <div
                    className="text-[10px]"
                    style={{ color: paletteVar("text"), opacity: 0.6 }}
                  >
                    SHIELDED
                  </div>
                  <div
                    className="font-bold tabular-nums"
                    style={{ color: paletteVar("ratio") }}
                  >
                    {shieldedPct.toFixed(2)}%
                  </div>
                </Link>
              )}
              <IronwoodAtGlance />
            </div>
          </div>
        </CornerBox>
      )}

      {/* Top tabs — terminal-style bracket buttons. Active tab gets
          a solid fill + glow + thicker bottom edge so the choice is
          unmistakable; inactive tab keeps the bracket frame but
          dims significantly. Bigger padding + text so the strip
          reads as a primary control rather than a sub-tab. */}
      <div className="flex items-end gap-1 md:gap-2 mb-4 overflow-x-auto">
        {ZEC_SECTIONS.map((v) => {
          const l = ZEC_SECTION_LABELS[v]
          const on = section === v
          return (
            <button
              key={v}
              type="button"
              onClick={() => openSection(v)}
              aria-pressed={on}
              // Padding and tracking tighten on mobile so all four sections
              // fit a 390px viewport without the row becoming a scroller —
              // the crowding this split was meant to fix.
              className="relative px-2 py-2 text-[11px] tracking-[0.1em] md:px-5 md:text-[12px] md:tracking-[0.2em] font-bold transition-all whitespace-nowrap focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
              style={{
                color: on ? paletteVar("cyph") : paletteVar("text"),
                opacity: on ? 1 : 0.55,
                background: on
                  ? `${paletteVar("cyph")}26`
                  : "transparent",
                boxShadow: on
                  ? `0 0 16px ${paletteVar("cyph")}66, inset 0 0 12px ${paletteVar("cyph")}22`
                  : "none",
                textShadow: on
                  ? `0 0 8px ${paletteVar("cyph")}88`
                  : "none",
                outlineColor: paletteVar("cyph"),
              }}
            >
              {/* Bracket frame around the label — reads as a
                  terminal-style tab even when inactive. Brackets
                  brighten with the label color so the active tab's
                  glow pulls them along. */}
              {(["┌", "┐", "└", "┘"] as const).map((g, i) => {
                const pos = [
                  "absolute left-0 top-0",
                  "absolute right-0 top-0",
                  "absolute left-0 bottom-0",
                  "absolute right-0 bottom-0",
                ][i]
                return (
                  <span
                    key={g}
                    aria-hidden="true"
                    className={`${pos} leading-none select-none`}
                    style={{
                      color: on ? paletteVar("cyph") : paletteVar("text"),
                    }}
                  >
                    {g}
                  </span>
                )
              })}
              {l}
            </button>
          )
        })}
      </div>

      {section === "rankings" && (
        <CornerBox
          label={`TOP-50 ${fdvOn ? "FDV" : "MARKET CAP"} · LIVE`}
          action={
            <RankingsToggles
              fdvOn={fdvOn}
              onFdvChange={setFdvOn}
              showPct={showPct}
              onShowPctChange={setShowPct}
            />
          }
        >
          {/* Two-layout grid (see beta.css `.cz-rank-grid`): on mobile
              we collapse to RANK · LOGO · COIN · 24H · OVERTAKE so
              the whole table fits in 375px without a horizontal
              scroll. On md+ the full 7-column layout (with PRICE +
              MCAP) renders. The header below uses the same template
              via CSS classes so it stays perfectly aligned with the
              rows. */}
          <div className="cz-rank-grid grid gap-0 px-1 py-1 border-b text-[10px] tracking-[0.2em]"
            style={{
              borderColor: `${paletteVar("text")}33`,
              color: paletteVar("text"),
              opacity: 0.7,
            }}
          >
            <span>RANK</span>
            <span />
            <span>COIN</span>
            <span className="cz-rank-price text-right">PRICE</span>
            <span className="text-right">24H</span>
            <span className="cz-rank-mcap text-right">{fdvOn ? "FDV" : "MCAP"}</span>
            <span className="text-right">{showPct ? "OVERTAKE%" : "OVERTAKE"}</span>
          </div>
          {coins.length === 0 && (
            <div
              className="px-3 py-6 text-[11px] text-center"
              style={{ color: paletteVar("text"), opacity: 0.6 }}
            >
              Loading rankings…
            </div>
          )}
          {coins.map((r) => {
              const isZec = r.symbol === "ZEC"
              const color = isZec ? paletteVar("zec") : paletteVar("text")
              const rValue = rankValue(r, metric)
              // OVERTAKE — for coins ranked above ZEC, show the ZEC
              // price delta needed so ZEC's mcap (or FDV — whichever
              // metric is active) crosses theirs. Coins ranked below
              // ZEC get "ZEC ahead"; ZEC's own row gets a self-
              // referential marker. The %-display variant divides
              // the price delta by ZEC's current spot.
              const overtake = (() => {
                if (isZec) return null
                if (zecMcap == null || zecSupply == null || zecSupply <= 0)
                  return null
                if (rValue == null) return null
                if (r.rank < zecRank!) {
                  const deltaZec = (rValue - zecMcap) / zecSupply
                  const deltaPct =
                    zecPrice != null && zecPrice > 0
                      ? (deltaZec / zecPrice) * 100
                      : null
                  return {
                    dir: "ahead" as const,
                    delta: deltaZec,
                    pct: deltaPct,
                  }
                }
                return {
                  dir: "behind" as const,
                  delta: null,
                  pct: null,
                }
              })()

              return (
                <div
                  key={r.symbol + r.rank}
                  className="cz-rank-grid grid gap-0 px-1 py-2 items-center transition-colors hover:bg-emerald-950/30"
                  style={{
                    borderBottom: `1px dotted ${paletteVar("text")}22`,
                    background: isZec ? "rgba(253, 224, 71, 0.08)" : undefined,
                  }}
                >
                  <span
                    className="text-[11px] tabular-nums font-bold"
                    style={{
                      color: isZec ? paletteVar("zec") : paletteVar("text"),
                      opacity: isZec ? 1 : 0.7,
                    }}
                  >
                    {isZec ? "►" : " "}#{r.rank}
                  </span>
                  {/* Real coin logo when the upstream gave us an image
                      URL; CoinLogo falls back to a 2-letter monogram on
                      404 so the row never looks broken. */}
                  <CoinLogo image={r.image ?? null} symbol={r.symbol} size={20} />
                  {/* min-w-0 + overflow-hidden lets the long names
                      truncate cleanly inside the grid 1fr column
                      instead of pushing the price/24H/MCAP columns
                      off-screen (e.g. World Liberty Financial). */}
                  <div className="min-w-0 overflow-hidden">
                    <div
                      className="text-[12px] font-bold truncate"
                      style={{ color }}
                    >
                      {r.symbol}
                    </div>
                    <div
                      className="text-[11px] truncate"
                      style={{ color: paletteVar("text"), opacity: 0.5 }}
                    >
                      {r.name}
                    </div>
                  </div>
                  <span className="cz-rank-price text-[11px] text-right tabular-nums">
                    {fmtPriceCompact(r.price)}
                  </span>
                  <span
                    className="text-[11px] text-right tabular-nums whitespace-nowrap"
                    style={{
                      color:
                        r.change24h == null
                          ? paletteVar("text")
                          : r.change24h >= 0
                            ? paletteVar("cyph")
                            : E_STATIC.red,
                    }}
                  >
                    {r.change24h != null
                      ? `${r.change24h >= 0 ? "▲" : "▼"} ${Math.abs(r.change24h).toFixed(2)}%`
                      : "—"}
                  </span>
                  <span className="cz-rank-mcap text-[11px] text-right tabular-nums">
                    {fmtCompactUSD(rValue)}
                  </span>
                  <span
                    className="text-[11px] text-right tabular-nums"
                    style={{
                      color:
                        isZec
                          ? paletteVar("zec")
                          : overtake?.dir === "behind"
                            ? paletteVar("text")
                            : paletteVar("ratio"),
                      opacity:
                        isZec ? 1 : overtake?.dir === "behind" ? 0.45 : 0.85,
                    }}
                  >
                    {isZec
                      ? "► ZEC ◄"
                      : overtake?.dir === "ahead" && overtake.delta != null
                        ? showPct && overtake.pct != null
                          ? `+${overtake.pct.toFixed(1)}%`
                          : "+" + fmtPriceCompact(overtake.delta)
                        : overtake?.dir === "behind"
                          ? "ZEC ahead"
                          : "—"}
                  </span>
                </div>
              )
          })}
        </CornerBox>
      )}

      {section !== "rankings" && (
        <>
          {/* Sub-tabs for the active section — bracket-style strip with
              visible borders on every tab so the row reads as a clearly
              tappable control set. Active tab fills + glows in amber;
              inactive tabs stay outlined but dim. Skipped entirely for a
              section with a single view (ORDER FLOW), where a lone tab
              would just be a label. */}
          {subViews.length > 1 && (
          <div className="flex items-center gap-1 mb-3 overflow-x-auto pb-1">
            {subViews.map(({ id: v }) => {
              const l = viewLabel(v, isMobile)
              const on = view === v
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  aria-pressed={on}
                  className="border px-3 py-1.5 text-[11px] tracking-[0.15em] font-bold transition-colors whitespace-nowrap focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 hover:opacity-100"
                  style={{
                    color: on ? paletteVar("zec") : paletteVar("text"),
                    opacity: on ? 1 : 0.85,
                    background: on
                      ? `${paletteVar("zec")}22`
                      : "rgba(255,255,255,0.03)",
                    borderColor: on ? paletteVar("zec") : `${paletteVar("text")}66`,
                    textShadow: on
                      ? `0 0 8px ${paletteVar("zec")}77`
                      : "none",
                    boxShadow: on
                      ? `0 0 12px ${paletteVar("zec")}33, inset 0 0 8px ${paletteVar("zec")}22`
                      : "none",
                    outlineColor: paletteVar("zec"),
                  }}
                >
                  {l}
                </button>
              )
            })}
          </div>
          )}

          {view === "rainbow" && (
            <PowerLawRainbow
              id="rainbow"
              asset="zec"
              livePrice={zecPrice}
              isMobile={isMobile}
            />
          )}

          {view === "supply" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <CornerBox label="CIRCULATING SUPPLY" color={paletteVar("zec")}>
                {zecSupply != null ? (
                  <>
                    <div
                      className="text-3xl font-bold tabular-nums"
                      style={{
                        color: paletteVar("zec"),
                        textShadow: `0 0 8px ${paletteVar("zec")}44`,
                      }}
                    >
                      {(zecSupply / 1e6).toFixed(2)}M ZEC
                    </div>
                    <div
                      className="text-[11px] mt-1"
                      style={{ color: paletteVar("text"), opacity: 0.6 }}
                    >
                      of 21M max supply
                    </div>
                    <div className="mt-3">
                      <BlockProgress
                        pct={(zecSupply / ZEC_MAX_SUPPLY) * 100}
                        width={28}
                        color={paletteVar("zec")}
                        label="MINED"
                        sub={`${((zecSupply / ZEC_MAX_SUPPLY) * 100).toFixed(2)}%`}
                      />
                    </div>
                    <div
                      className="text-[11px] mt-2"
                      style={{ color: paletteVar("text"), opacity: 0.6 }}
                    >
                      ~{((ZEC_MAX_SUPPLY - zecSupply) / 1e6).toFixed(2)}M ZEC remaining to mint
                    </div>
                  </>
                ) : (
                  <div
                    className="text-[11px]"
                    style={{ color: paletteVar("text"), opacity: 0.5 }}
                  >
                    Loading supply…
                  </div>
                )}
              </CornerBox>
              {/* Emission curve — theoretical total ZEC supply issued
                  through mining subsidies (including the slow-start ramp
                  and all halvings). This should always rise; it is not
                  affected by shielding/unshielding movements. */}
              <CornerBox
                label="EMISSION CURVE · ALL"
                color={paletteVar("zec")}
                action={
                  <span
                    className="text-[11px] tracking-[0.2em] font-bold"
                    style={{ color: paletteVar("zec") }}
                  >
                    MAX 21M
                  </span>
                }
              >
                {emissionAllPoints.length >= 2 ? (
                  <EmissionCurveChart
                    data={emissionAllPoints}
                    height={isMobile ? 210 : 220}
                    viewBoxWidth={chartW}
                  />
                ) : (
                  <div
                    className="text-[11px] py-12 text-center"
                    style={{ color: paletteVar("text"), opacity: 0.5 }}
                  >
                    Loading emission curve...
                  </div>
                )}
              </CornerBox>
              {/* Price overlay stays on the SUPPLY tab — it's the
                  longest-running real series we have for the chain
                  and reads naturally below the supply readouts. */}
              <div className="md:col-span-2">
                <CornerBox label="PRICE HISTORY · 90D">
                  <MultiLineChartE
                    data={(prices90?.history ?? []).map((h) => ({
                      date: h.date,
                      cyph: h.cyph,
                      zec: h.zec,
                      ratio: h.ratio,
                    }))}
                    height={isMobile ? 180 : 220}
                    showRatio={false}
                    viewBoxWidth={chartW}
                  />
                </CornerBox>
              </div>
            </div>
          )}

          {view === "shielded" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <CornerBox
                label="SHIELDED POOLS"
                color={paletteVar("ratio")}
                action={
                  <span className="inline-flex items-center gap-2">
                    <Link
                      href="/shielding"
                      className="text-[11px] tracking-[0.2em] hover:underline"
                      style={{ color: paletteVar("ratio") }}
                    >
                      DETAILS -&gt;
                    </Link>
                    <a
                      href="https://zechub.wiki/zcashdocs/zcash-overview/shielded-pools"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] tracking-[0.2em] hover:underline"
                      style={{ color: paletteVar("ratio") }}
                    >
                      LEARN -&gt;
                    </a>
                  </span>
                }
              >
                {shieldedPct != null && zecSupply != null ? (
                  <>
                    <div
                      className="text-3xl font-bold tabular-nums"
                      style={{
                        color: paletteVar("ratio"),
                        textShadow: `0 0 8px ${paletteVar("ratio")}44`,
                      }}
                    >
                      {(((zecSupply * shieldedPct) / 100) / 1e6).toFixed(2)}M ZEC
                    </div>
                    <div
                      className="text-[11px] mt-1"
                      style={{ color: paletteVar("text"), opacity: 0.6 }}
                    >
                      {shieldedPct.toFixed(2)}% of circulating supply
                    </div>
                    <div className="mt-3">
                      <BlockProgress
                        pct={shieldedPct}
                        width={28}
                        color={paletteVar("ratio")}
                        label="SHIELDED"
                        sub={`${shieldedPct.toFixed(2)}%`}
                      />
                    </div>
                    {shielded && (
                      <div className="grid grid-cols-5 gap-1 mt-3 text-[9px] sm:text-[10px]">
                        {(() => {
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
                                className="text-center px-1 py-1.5 border"
                                style={{ borderColor: c + "55" }}
                              >
                                <div style={{ color: c }}>{l}</div>
                                <div
                                  className="font-bold tabular-nums"
                                  style={{ color: c }}
                                >
                                  {pct < 0.01 ? "0%" : pct.toFixed(2) + "%"}
                                </div>
                              </div>
                            )
                          })
                        })()}
                      </div>
                    )}
                  </>
                ) : (
                  <div
                    className="text-[11px]"
                    style={{ color: paletteVar("text"), opacity: 0.5 }}
                  >
                    Loading shielded data…
                  </div>
                )}
              </CornerBox>
              {/* Trend beside the headline, so OVERVIEW answers "how much
                  is shielded, and which way is it going" without needing
                  the full stacked chart. Fixed 90d rather than sharing the
                  CHART tab's window selector: this is a glance, and its
                  scale should not change under the user from another tab. */}
              <CornerBox label="SHIELDED TOTAL · 90D" color={paletteVar("ratio")}>
                {shieldedTrendPoints.length >= 2 ? (
                  <>
                    <SimpleLineChartE
                      data={shieldedTrendPoints}
                      accessor={(d) => d.total / 1e6}
                      color={paletteVar("ratio")}
                      height={isMobile ? 150 : 190}
                      format={(v) => `${v.toFixed(2)}M`}
                      label="M ZEC SHIELDED"
                      viewBoxWidth={chartW}
                    />
                    {shieldedTrendDelta != null && (
                      <div
                        className="mt-2 text-[11px]"
                        style={{ color: paletteVar("text"), opacity: 0.7 }}
                      >
                        <span
                          className="font-bold tabular-nums"
                          style={{
                            color:
                              shieldedTrendDelta >= 0
                                ? paletteVar("cyph")
                                : E_STATIC.red,
                          }}
                        >
                          {shieldedTrendDelta >= 0 ? "+" : ""}
                          {shieldedTrendDelta.toFixed(2)}M ZEC
                        </span>{" "}
                        over the window
                      </div>
                    )}
                  </>
                ) : (
                  <div
                    className="text-[11px] py-12 text-center"
                    style={{ color: paletteVar("text"), opacity: 0.5 }}
                  >
                    Loading shielded history…
                  </div>
                )}
              </CornerBox>
            </div>
          )}

          {view === "shieldedStats" && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
              {/* Pool breakdown · current — horizontal bars with pool
                  descriptors and absolute holdings. Reads like a row legend
                  so users coming off the chart understand what each pool
                  actually means. */}
              <CornerBox label="POOL BREAKDOWN · CURRENT" color={paletteVar("ratio")}>
                {shielded ? (
                  <PoolBreakdown shielded={shielded} />
                ) : (
                  <div
                    className="text-[11px] py-6 text-center"
                    style={{ color: paletteVar("text"), opacity: 0.5 }}
                  >
                    Pool breakdown loading…
                  </div>
                )}
              </CornerBox>
              {/* The other half of the composition question: how much of the
                  chain is shielded at all. `transparent` and `chainSupply`
                  already ride along in the breakdown payload and had no
                  surface before this. */}
              <CornerBox label="SHIELDED VS TRANSPARENT" color={paletteVar("ratio")}>
                {shielded ? (
                  (() => {
                    const transparent = shielded.transparent ?? 0
                    // Prefer the node's own chain supply; fall back to the
                    // parts we have so the split still renders on an older
                    // cached payload that predates the field.
                    const chain =
                      shielded.chainSupply != null && shielded.chainSupply > 0
                        ? shielded.chainSupply
                        : transparent + shielded.total + shielded.lockbox
                    const shieldedShare =
                      chain > 0 ? (shielded.total / chain) * 100 : null
                    const rows: [string, number, string][] = [
                      ["SHIELDED", shielded.total, paletteVar("ratio")],
                      ["TRANSPARENT", transparent, paletteVar("zec")],
                      ["LOCKBOX", shielded.lockbox, POOL_COLORS.lockbox],
                    ]
                    return (
                      <>
                        <div
                          className="text-3xl font-bold tabular-nums"
                          style={{
                            color: paletteVar("ratio"),
                            textShadow: `0 0 8px ${paletteVar("ratio")}44`,
                          }}
                        >
                          {shieldedShare == null
                            ? "—"
                            : `${shieldedShare.toFixed(2)}%`}
                        </div>
                        <div
                          className="text-[11px] mt-1"
                          style={{ color: paletteVar("text"), opacity: 0.6 }}
                        >
                          of {(chain / 1e6).toFixed(2)}M ZEC on chain is in a
                          shielded pool
                        </div>
                        {/* One bar, three segments — the whole chain at a
                            glance rather than three separate percentages. */}
                        <div
                          className="flex mt-3 h-3 overflow-hidden"
                          style={{ border: `1px solid ${paletteVar("text")}22` }}
                        >
                          {rows.map(([label, amt, color]) => {
                            const pct = chain > 0 ? (amt / chain) * 100 : 0
                            if (pct <= 0) return null
                            return (
                              <div
                                key={label}
                                style={{
                                  width: `${pct}%`,
                                  background: color,
                                  opacity: 0.8,
                                }}
                                title={`${label} · ${(amt / 1e6).toFixed(2)}M ZEC · ${pct.toFixed(2)}%`}
                              />
                            )
                          })}
                        </div>
                        <div className="mt-3 flex flex-col gap-1.5 text-[11px]">
                          {rows.map(([label, amt, color]) => {
                            const pct = chain > 0 ? (amt / chain) * 100 : 0
                            return (
                              <div
                                key={label}
                                className="flex items-baseline gap-2"
                              >
                                <span
                                  aria-hidden="true"
                                  className="inline-block size-2.5 shrink-0"
                                  style={{
                                    background: color,
                                    boxShadow: `0 0 4px ${color}88`,
                                  }}
                                />
                                <span
                                  className="w-24 font-bold tracking-wider"
                                  style={{ color }}
                                >
                                  {label}
                                </span>
                                <span
                                  className="w-16 tabular-nums font-bold text-right"
                                  style={{ color }}
                                >
                                  {pct < 0.01 ? "0%" : `${pct.toFixed(2)}%`}
                                </span>
                                <span
                                  className="tabular-nums"
                                  style={{
                                    color: paletteVar("text"),
                                    opacity: 0.65,
                                  }}
                                >
                                  {amt >= 1e6
                                    ? `${(amt / 1e6).toFixed(2)}M`
                                    : `${(amt / 1e3).toFixed(1)}K`}{" "}
                                  ZEC
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </>
                    )
                  })()
                ) : (
                  <div
                    className="text-[11px] py-6 text-center"
                    style={{ color: paletteVar("text"), opacity: 0.5 }}
                  >
                    Loading chain split…
                  </div>
                )}
              </CornerBox>
            </div>
          )}

          {view === "shieldedChart" && (
            <CornerBox
              label={
                isMobile
                  ? "SHIELDED POOLS"
                  : `SHIELDED POOLS · ${shieldedChartWindow}`
              }
              color={paletteVar("ratio")}
              action={
                <WindowChips
                  value={shieldedChartWindow}
                  onChange={setShieldedChartWindow}
                  options={["7D", "30D", "90D", "1Y", "ALL"]}
                  color={paletteVar("ratio")}
                />
              }
            >
              {shieldedChartPoints.length >= 2 ? (
                <>
                  {/* Newest pools sit on top of the stack. The upstream
                      history source includes Ironwood but not Lockbox, so
                      Lockbox remains a current-only Pool Breakdown row. */}
                  <StackedAreaChart
                    data={shieldedChartPoints}
                    keys={["sprout", "sapling", "orchard", "ironwood"]}
                    colors={[
                      POOL_COLORS.sprout,
                      POOL_COLORS.sapling,
                      POOL_COLORS.orchard,
                      POOL_COLORS.ironwood,
                    ]}
                    height={isMobile ? 220 : 280}
                    viewBoxWidth={chartW}
                  />
                  <div className="flex flex-wrap gap-3 mt-3 text-[11px]">
                    {(
                      [
                        ["IRONWOOD", POOL_COLORS.ironwood],
                        ["ORCHARD", POOL_COLORS.orchard],
                        ["SAPLING", POOL_COLORS.sapling],
                        ["SPROUT", POOL_COLORS.sprout],
                      ] as const
                    ).map(([l, c]) => (
                      <span key={l} className="flex items-center gap-1.5">
                        <span
                          className="inline-block size-2.5"
                          style={{
                            background: c,
                            boxShadow: `0 0 4px ${c}88`,
                          }}
                        />
                        <span style={{ color: c }}>{l}</span>
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <div
                  className="text-[11px] py-12 text-center"
                  style={{ color: paletteVar("text"), opacity: 0.5 }}
                >
                  {shieldedAllPoints.length === 0
                    ? "Loading per-pool history…"
                    : `Not enough data in ${shieldedChartWindow} — try a longer window.`}
                </div>
              )}
            </CornerBox>
          )}

          {view === "transactions" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {txDataStale && (
                <div
                  className="md:col-span-2 px-3 py-2 text-[11px] leading-relaxed"
                  style={{
                    color: paletteVar("amber"),
                    border: `1px solid ${paletteVar("amber")}55`,
                    background: `${paletteVar("amber")}0c`,
                  }}
                >
                  Transaction-history source currently ends{" "}
                  <span className="font-bold tabular-nums">
                    {readableDate(txLatestDate)}
                  </span>
                  .
                </div>
              )}
              <CornerBox
                label={`DAILY TRANSACTIONS · ${txWindow}`}
                color={paletteVar("cyph")}
                className="md:col-span-2"
                action={
                  <WindowChips
                    value={txWindow}
                    onChange={setTxWindow}
                    options={["7D", "30D", "90D", "1Y", "ALL"]}
                    color={paletteVar("cyph")}
                  />
                }
              >
                {txPoints.length >= 2 ? (
                  <SimpleLineChartE
                    data={txPoints}
                    accessor={(d) => d.total}
                    color={paletteVar("cyph")}
                    height={isMobile ? 200 : 240}
                    format={(v) =>
                      v >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toLocaleString()
                    }
                    label="TX"
                    viewBoxWidth={chartW}
                  />
                ) : (
                  <div
                    className="text-[11px] py-12 text-center"
                    style={{ color: paletteVar("text"), opacity: 0.5 }}
                  >
                    Loading daily tx history…
                  </div>
                )}
              </CornerBox>
              <CornerBox
                label={`SHIELDED TX · ${txWindow}`}
                color={paletteVar("ratio")}
              >
                {txPoints.length >= 2 ? (
                  <SimpleLineChartE
                    data={txPoints}
                    accessor={(d) => d.shielded}
                    color={paletteVar("ratio")}
                    height={180}
                    format={(v) => v.toLocaleString()}
                    viewBoxWidth={chartW}
                    label="SHIELDED"
                  />
                ) : (
                  <div
                    className="text-[11px] py-12 text-center"
                    style={{ color: paletteVar("text"), opacity: 0.5 }}
                  >
                    Loading shielded tx history…
                  </div>
                )}
              </CornerBox>
              <CornerBox label="SHIELDED RATIO" color={paletteVar("ratio")}>
                <div
                  className="text-3xl font-bold tabular-nums"
                  style={{
                    color: paletteVar("ratio"),
                    textShadow: `0 0 8px ${paletteVar("ratio")}44`,
                  }}
                >
                  {lastShieldedRatio != null
                    ? lastShieldedRatio.toFixed(1) + "%"
                    : "—"}
                </div>
                <div
                  className="text-[11px] mt-1"
                  style={{ color: paletteVar("text"), opacity: 0.6 }}
                >
                  of recent daily transactions touch a shielded pool
                </div>
                {lastTx && (
                  <div
                    className="mt-3 text-[11px]"
                    style={{ color: paletteVar("text"), opacity: 0.7 }}
                  >
                    Latest ({readableDate(lastTx.sourceDate)}):{" "}
                    <span
                      className="font-bold tabular-nums"
                      style={{ color: paletteVar("cyph") }}
                    >
                      {lastTx.total.toLocaleString()}
                    </span>{" "}
                    total ·{" "}
                    <span
                      className="font-bold tabular-nums"
                      style={{ color: paletteVar("ratio") }}
                    >
                      {lastTx.shielded.toLocaleString()}
                    </span>{" "}
                    shielded
                  </div>
                )}
              </CornerBox>
            </div>
          )}

          {/* EXCHANGES — heat-map + per-venue table for ZEC's 24h volume
              distribution. Lazy-mounted (the SWR fetch lives inside
              <ExchangesTab>) so cold loads on the rankings + supply tabs
              don't pull the per-pair tickers feed. */}
          {view === "exchanges" && <ExchangesTab />}

          {/* ORDER FLOW — aggregated order-book depth, taker tape and the
              price-action analytics. `history` hands it the daily closes
              this page already fetched so the RSI / drawdown numbers cost
              no extra request. */}
          {view === DEPTH_STATS_VIEW && (
            <OrderFlowPanels
              history={prices90?.history}
              isMobile={isMobile}
            />
          )}
        </>
      )}

    </>
  )
}

// ──────────────────────────────────────────────────────────────────────
// Horizontal pool breakdown — bars proportional to each pool's share
// of the shielded supply, with the protocol-relevant blurb next to
// each name. Inline so the colour map + descriptions stay tight to
// the surface that consumes them.
// ──────────────────────────────────────────────────────────────────────
function PoolBreakdown({
  shielded,
}: {
  shielded: {
    ironwood: number
    orchard: number
    sapling: number
    sprout: number
    lockbox: number
  }
}) {
  const totalShielded =
    shielded.ironwood +
    shielded.orchard +
    shielded.sapling +
    shielded.sprout +
    shielded.lockbox
  if (totalShielded <= 0) {
    return (
      <div
        className="text-[11px] py-6 text-center"
        style={{ color: paletteVar("text"), opacity: 0.5 }}
      >
        No pool data yet.
      </div>
    )
  }
  const rows: [string, number, string, string][] = [
    ["IRONWOOD", shielded.ironwood, POOL_COLORS.ironwood, "Newest pool · NU6.3 migration target"],
    ["ORCHARD", shielded.orchard, POOL_COLORS.orchard, "Previous pool · Halo 2 zk-SNARKs"],
    ["SAPLING", shielded.sapling, POOL_COLORS.sapling, "Older pool · still in active use"],
    ["SPROUT", shielded.sprout, POOL_COLORS.sprout, "Legacy · users migrating out"],
    ["LOCKBOX", shielded.lockbox, POOL_COLORS.lockbox, "Custodial reserve funds"],
  ]
  return (
    <div className="text-[11px] mt-1 flex flex-col gap-2">
      {rows.map(([name, amt, color, sub]) => {
        const pct = (amt / totalShielded) * 100
        const barPct = Math.min(100, pct)
        return (
          <div key={name} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-3">
              <span
                className="w-20 font-bold tracking-wider"
                style={{ color }}
              >
                {name}
              </span>
              <span
                className="w-14 tabular-nums font-bold"
                style={{ color }}
              >
                {pct < 0.01 ? "0%" : pct.toFixed(2) + "%"}
              </span>
              <div
                className="flex-1 h-1.5 relative"
                style={{ background: color + "1a" }}
              >
                <div
                  className="absolute inset-y-0 left-0"
                  style={{
                    width: barPct + "%",
                    background: color,
                    boxShadow: `0 0 4px ${color}88`,
                  }}
                />
              </div>
            </div>
            <div
              className="text-[10px] pl-20"
              style={{ color: paletteVar("text"), opacity: 0.5 }}
            >
              <span className="tabular-nums" style={{ opacity: 0.9 }}>
                {amt >= 1e6
                  ? `${(amt / 1e6).toFixed(2)}M`
                  : amt >= 1e3
                    ? `${(amt / 1e3).toFixed(1)}K`
                    : amt.toFixed(0)}{" "}
                ZEC
              </span>
              {" · "}
              {sub}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────
// Two paired segmented controls in the rankings card header:
//   • MCAP vs FDV — switches the value column + sort order
//   • $ vs %      — switches OVERTAKE between absolute price delta
//                   and the % of ZEC's spot it represents
// Designed to fit narrow mobile widths: each toggle is a 2-option pill
// that hugs its content, so the pair takes ~140px total at text-[11px].
// ──────────────────────────────────────────────────────────────────────
function RankingsToggles({
  fdvOn,
  onFdvChange,
  showPct,
  onShowPctChange,
}: {
  fdvOn: boolean
  onFdvChange: (v: boolean) => void
  showPct: boolean
  onShowPctChange: (v: boolean) => void
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <SegToggle
        ariaLabel="Ranking metric"
        options={[
          { value: false, label: "MCAP" },
          { value: true, label: "FDV" },
        ]}
        value={fdvOn}
        onChange={onFdvChange}
        color={paletteVar("zec")}
      />
      <SegToggle
        ariaLabel="Overtake display"
        options={[
          { value: false, label: "$" },
          { value: true, label: "%" },
        ]}
        value={showPct}
        onChange={onShowPctChange}
        color={paletteVar("ratio")}
      />
    </span>
  )
}

function SegToggle<T>({
  options,
  value,
  onChange,
  color,
  ariaLabel,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  color: string
  ariaLabel: string
}) {
  return (
    <span
      role="group"
      aria-label={ariaLabel}
      className="inline-flex items-center border"
      style={{ borderColor: `${paletteVar("text")}33` }}
    >
      {options.map((o, i) => {
        const on = value === o.value
        return (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={on}
            className="px-2 py-0.5 text-[11px] tracking-[0.1em] font-bold transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
            style={{
              color: on ? color : paletteVar("text"),
              opacity: on ? 1 : 0.65,
              background: on ? `${color}1f` : "transparent",
              borderLeftWidth: i > 0 ? 1 : 0,
              borderLeftStyle: "solid",
              borderLeftColor: `${paletteVar("text")}33`,
              outlineColor: color,
            }}
          >
            {o.label}
          </button>
        )
      })}
    </span>
  )
}
