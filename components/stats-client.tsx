"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import Link from "next/link"
import dynamic from "next/dynamic"
import { usePersistentState } from "@/lib/use-persistent-state"
import {
  ArrowLeft,
  ListOrdered,
  ShieldCheck,
  Coins,
  ArrowUpRight,
  ArrowDownRight,
  ExternalLink,
  Flame,
  RefreshCw,
  Activity,
} from "lucide-react"
import { PerfChip } from "@/components/perf-chip"

// Recharts (used inside SupplyCharts) is a 150KB+ library that only
// renders on the client. Dynamic-import it so the rankings tab — which
// is the page's default — doesn't drag chart code into its bundle, and
// so the chart code only loads once the user actually opens Supply.
const SupplyCharts = dynamic(
  () => import("@/components/supply-charts").then((m) => m.SupplyCharts),
  {
    ssr: false,
    loading: () => (
      <div className="h-48 md:h-64 flex items-center justify-center">
        <RefreshCw className="size-5 animate-spin text-muted-foreground" />
      </div>
    ),
  }
)
// Same code-split treatment for the Volume tab — its bar+line chart
// is the only Recharts user there, so we load it lazily as well.
const VolumeChart = dynamic(
  () => import("@/components/volume-charts").then((m) => m.VolumeChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-48 md:h-64 flex items-center justify-center">
        <RefreshCw className="size-5 animate-spin text-muted-foreground" />
      </div>
    ),
  }
)

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const json = await res.json()
  if (!res.ok || (json && typeof json === "object" && "error" in json)) {
    throw new Error(json?.error ?? `Request failed: ${res.status}`)
  }
  return json
}

interface MarketCoin {
  rank: number
  symbol: string
  name: string
  id: string
  marketCap: number | null
  /** Fully diluted market cap; nullable when upstream didn't provide
   *  it AND we couldn't compute price × max/total supply. The FDV
   *  toggle falls back to marketCap when this is null so the table
   *  still has a value to render. */
  fdv: number | null
  price: number | null
  change24h: number | null
  circulatingSupply: number | null
  totalSupply: number | null
  maxSupply: number | null
  image: string | null
}

interface MarketsResponse {
  coins: MarketCoin[]
  fetchedAt: number
  source: string
  excluded?: string[]
}

interface ShieldedBreakdown {
  total: number
  sprout: number
  sapling: number
  orchard: number
  lockbox: number
  transparent: number
  pct: number
  source: string
}

interface ZecStats {
  rank: number | null
  marketCap: number | null
  price: number | null
  change24h: number | null
  mcapChange24h: number | null
  mcapChange7d: number | null
  mcapChange30d: number | null
  mcapSeries: [number, number][]
  /** Most recent 24h ZEC trading volume in USD. */
  volume24h: number | null
  /** [unix-ms, volume-usd][] 30d daily series — feeds the Volume tab. */
  volumeSeries: [number, number][]
  circulating: number | null
  total: number | null
  max: number
  ath: number | null
  athChangePct: number | null
  shielded: number | null
  shieldedPct: number | null
  shieldedBreakdown: ShieldedBreakdown | null
  shieldedSource: string | null
  source: string | null
  fetchedAt: number
}

const ZEC_COLOR = "#fb923c"
const GOOD = "#34d399"
const BAD = "#f87171"

// ─── formatting helpers ─────────────────────────────────────────────────────

function fmtMcap(n: number | null) {
  if (n == null || !Number.isFinite(n)) return "—"
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

function fmtPrice(p: number | null) {
  if (p == null) return "—"
  if (p >= 1)
    return `$${p.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  return `$${p.toFixed(4)}`
}

function fmtPct(p: number | null) {
  if (p == null) return "—"
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`
}

function fmtSignedUSD(n: number) {
  const sign = n > 0 ? "+" : n < 0 ? "−" : ""
  return `${sign}${fmtMcap(Math.abs(n))}`
}

/** Compact signed dollar value for the Δ-to-ZEC column. K / M
 *  abbreviations on anything ≥ $1k so a 5-digit delta doesn't dominate
 *  a phone-width row. Two decimals for sub-$10k, one decimal for
 *  $10k–$1M, two decimals for $1M+. Sub-$100 values keep two decimals
 *  so the chip is still legible when ZEC is just inches from a flip. */
function fmtDeltaCompact(n: number): string {
  const abs = Math.abs(n)
  const sign = n > 0 ? "+" : n < 0 ? "−" : ""
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e4) return `${sign}$${(abs / 1e3).toFixed(1)}K`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`
  if (abs >= 100) return `${sign}$${abs.toFixed(0)}`
  return `${sign}$${abs.toFixed(2)}`
}

function fmtCount(n: number | null) {
  if (n == null) return "—"
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 })
}

// ─── shared ──────────────────────────────────────────────────────────────────

type StatsTab = "rankings" | "supply" | "volume"
const isStatsTab = (v: unknown): v is StatsTab =>
  v === "rankings" || v === "supply" || v === "volume"

export function StatsClient() {
  const [tab, setTab] = usePersistentState<StatsTab>(
    "cyphzec.stats.tab",
    "rankings",
    isStatsTab
  )

  // Deep-link support: e.g. /stats?tab=supply from the dashboard's
  // shielded chip jumps straight to the Supply tab regardless of
  // the user's persisted preference. We strip the param after
  // applying it so navigating back-and-forth doesn't keep forcing
  // a tab on subsequent visits.
  useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const requested = params.get("tab")
    if (isStatsTab(requested)) {
      setTab(requested)
      params.delete("tab")
      const qs = params.toString()
      const next =
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash
      window.history.replaceState(null, "", next)
    }
  }, [setTab])

  return (
    <div className="flex flex-col gap-4">
      {/* Tab bar */}
      <div className="rounded-lg border border-border bg-card flex flex-wrap">
        {(
          [
            { id: "rankings", label: "Rankings", icon: ListOrdered },
            { id: "supply", label: "ZEC Supply", icon: Coins },
            { id: "volume", label: "ZEC Volume", icon: Activity },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-3 text-xs font-mono font-semibold border-b-2 transition-colors ${
              tab === id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>

      {tab === "rankings" && <RankingsTab />}
      {tab === "supply" && <SupplyTab />}
      {tab === "volume" && <VolumeTab />}

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

// ─── Rankings tab ────────────────────────────────────────────────────────────

// The metric the leaderboard sorts + displays in the Market cap column.
// FDV (fully diluted) reads as "where would this rank if every token
// that will ever exist was already on the market", which is what
// users tend to compare against when looking at long-run dilution.
type RankMetric = "marketCap" | "fdv"

// Pick the value the leaderboard should sort/display for a given coin
// under the active metric. FDV falls back to marketCap when the
// upstream couldn't compute one (e.g. CoinPaprika rows for coins
// without a max/total supply on the way out) so the table still has
// a number to render rather than a blank cell.
function valueFor(c: MarketCoin, metric: RankMetric): number | null {
  if (metric === "fdv") return c.fdv ?? c.marketCap
  return c.marketCap
}

function RankingsTab() {
  const { data, error, isLoading } = useSWR<MarketsResponse>(
    "/api/markets",
    fetcher,
    {
      refreshInterval: 5 * 60_000,
      revalidateOnFocus: true,
      keepPreviousData: true,
    }
  )
  const [showPct, setShowPct] = usePersistentState<boolean>(
    "cyphzec.stats.showPct",
    false,
    (v): v is boolean => typeof v === "boolean"
  )
  // FDV toggle. Persisted in localStorage so the user's preference
  // survives a refresh / re-open. When on, we re-sort the leaderboard
  // by FDV (re-numbering rank 1..N locally) and the Market-cap column
  // + ZEC summary + Δ-to-ZEC math all switch over to FDV values.
  const [fdvOn, setFdvOn] = usePersistentState<boolean>(
    "cyphzec.stats.fdv",
    false,
    (v): v is boolean => typeof v === "boolean"
  )
  const metric: RankMetric = fdvOn ? "fdv" : "marketCap"

  // When the FDV toggle flips, re-sort the upstream's mcap-ordered list
  // by FDV and re-number ranks 1..N so the # column matches the
  // displayed value. When the toggle is off we keep the upstream's
  // ranking as-is (which is already mcap-sorted from CMC). Stable sort
  // by symbol as a tiebreaker so rows don't visually jitter on ticks
  // that don't change the metric value.
  const allCoins = useMemo<MarketCoin[]>(() => {
    const raw = data?.coins ?? []
    if (!fdvOn) return raw
    const sorted = raw.toSorted((a, b) => {
      const av = valueFor(a, "fdv") ?? -Infinity
      const bv = valueFor(b, "fdv") ?? -Infinity
      if (bv !== av) return bv - av
      return a.symbol.localeCompare(b.symbol)
    })
    return sorted.map((c, i) => ({ ...c, rank: i + 1 }))
  }, [data?.coins, fdvOn])

  const zec = useMemo(
    () => allCoins.find((c) => c.symbol === "ZEC") ?? null,
    [allCoins]
  )

  // We render top 20 by default. If ZEC isn't in top 20, we still show
  // a focused window of ZEC ± 3 below the table.
  const top20 = allCoins.slice(0, 20)
  const zecInTop20 = (zec?.rank ?? 999) <= 20
  const neighbors = useMemo(() => {
    if (!zec || zecInTop20) return []
    const idx = allCoins.findIndex((c) => c.symbol === "ZEC")
    if (idx < 0) return []
    return allCoins.slice(
      Math.max(0, idx - 3),
      Math.min(allCoins.length, idx + 4)
    )
  }, [allCoins, zec, zecInTop20])

  if (isLoading && !data) {
    return (
      <p className="text-sm text-muted-foreground p-4">
        Loading top 50 by market cap…
      </p>
    )
  }
  if (error || !data) {
    return (
      <p className="text-sm text-destructive-foreground p-4">
        Couldn&rsquo;t load market data right now. Try again in a bit.
      </p>
    )
  }

  const zecValue = zec ? valueFor(zec, metric) : null
  const metricLabelShort = fdvOn ? "FDV" : "mcap"

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs font-mono text-muted-foreground">
          {zec ? (
            <>
              <span style={{ color: ZEC_COLOR }}>$ZEC</span>{" "}
              <span className="text-foreground font-bold">#{zec.rank}</span> ·{" "}
              {fmtMcap(zecValue)} {metricLabelShort}
            </>
          ) : (
            "ZEC not found in top 50"
          )}
        </p>
        <div className="flex items-center gap-2 text-[10px] font-mono">
          {/* Mcap / FDV metric toggle. Same segmented-button language
              as the $/% toggle so the two read as a pair. Persisted to
              localStorage so the user's choice survives reloads. */}
          <div className="flex items-center" role="group" aria-label="Market cap metric">
            <button
              onClick={() => setFdvOn(false)}
              className={`px-2 py-1 rounded-l border ${
                !fdvOn
                  ? "bg-secondary text-foreground border-border"
                  : "border-border/50 text-muted-foreground hover:text-foreground"
              }`}
              title="Sort & display by current market cap (price × circulating supply)"
            >
              Mcap
            </button>
            <button
              onClick={() => setFdvOn(true)}
              className={`px-2 py-1 rounded-r border-y border-r ${
                fdvOn
                  ? "bg-secondary text-foreground border-border"
                  : "border-border/50 text-muted-foreground hover:text-foreground"
              }`}
              title="Sort & display by fully diluted valuation (price × total/max supply)"
            >
              FDV
            </button>
          </div>
          {/* $ vs % toggle for the gap column */}
          <div className="flex items-center" role="group" aria-label="Δ to ZEC unit">
            <button
              onClick={() => setShowPct(false)}
              className={`px-2 py-1 rounded-l border ${
                !showPct
                  ? "bg-secondary text-foreground border-border"
                  : "border-border/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              $
            </button>
            <button
              onClick={() => setShowPct(true)}
              className={`px-2 py-1 rounded-r border-y border-r ${
                showPct
                  ? "bg-secondary text-foreground border-border"
                  : "border-border/50 text-muted-foreground hover:text-foreground"
              }`}
            >
              %
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        <RankingsTable
          coins={top20}
          zec={zec}
          showPct={showPct}
          metric={metric}
        />
      </div>

      {neighbors.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground pt-2">
            Near $ZEC (rank #{zec?.rank})
          </h3>
          <div className="rounded-lg border border-border bg-card overflow-x-auto">
            <RankingsTable
              coins={neighbors}
              zec={zec}
              showPct={showPct}
              metric={metric}
            />
          </div>
        </div>
      )}

    </div>
  )
}

function RankingsTable({
  coins,
  zec,
  showPct,
  metric,
}: {
  coins: MarketCoin[]
  zec: MarketCoin | null
  showPct: boolean
  metric: RankMetric
}) {
  // Fire-tag the biggest 24h gainer in this slice, so users get a
  // quick "who's pumping" read without scanning every row.
  const hottest = coins.reduce<MarketCoin | null>(
    (acc, c) =>
      c.change24h != null && (!acc || (c.change24h ?? 0) > (acc.change24h ?? 0))
        ? c
        : acc,
    null
  )
  const hottestId =
    hottest && (hottest.change24h ?? 0) > 5 ? hottest.id : null
  return (
    <table className="w-full text-xs font-mono">
      <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
        <tr className="border-b border-border/40">
          <th className="text-left pl-3 pr-1 py-2 font-normal w-10">#</th>
          <th className="text-left p-2 font-normal">Coin</th>
          <th className="text-right p-2 font-normal">
            {metric === "fdv" ? "FDV" : "Market cap"}
          </th>
          <th className="text-right p-2 font-normal hidden sm:table-cell">
            Price
          </th>
          <th className="text-right p-2 font-normal">24h</th>
          <th className="text-right px-3 py-2 font-normal">Δ to ZEC</th>
        </tr>
      </thead>
      <tbody>
        {coins.map((c) => (
          <RankingsRow
            key={c.id}
            c={c}
            zec={zec}
            showPct={showPct}
            metric={metric}
            isHottest={c.id === hottestId}
          />
        ))}
      </tbody>
    </table>
  )
}

/** Logo with a letter-monogram fallback when the image URL 404s or the
 *  upstream returns null. CoinPaprika's logos are 404-prone for newer
 *  tickers, and CoinGecko occasionally omits the field entirely. */
function CoinLogo({
  image,
  symbol,
  size = 16,
}: {
  image: string | null
  symbol: string
  size?: number
}) {
  const [broken, setBroken] = useState(false)
  if (!image || broken) {
    return (
      <span
        className="inline-flex items-center justify-center rounded-full bg-muted text-[9px] font-mono text-muted-foreground flex-shrink-0"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        {symbol.slice(0, 2)}
      </span>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={image}
      alt=""
      width={size}
      height={size}
      className="rounded-full flex-shrink-0"
      loading="lazy"
      onError={() => setBroken(true)}
    />
  )
}

/** Medal glyph for the podium slots — adds personality without leaning
 *  on emoji rendering, which varies wildly across phones. */
function rankBadge(rank: number) {
  if (rank === 1)
    return (
      <span className="inline-flex items-center justify-center size-5 rounded-full bg-amber-300/15 border border-amber-300/40 text-amber-300 text-[10px] font-bold leading-none">
        1
      </span>
    )
  if (rank === 2)
    return (
      <span className="inline-flex items-center justify-center size-5 rounded-full bg-zinc-300/10 border border-zinc-300/40 text-zinc-200 text-[10px] font-bold leading-none">
        2
      </span>
    )
  if (rank === 3)
    return (
      <span className="inline-flex items-center justify-center size-5 rounded-full bg-orange-700/15 border border-orange-700/40 text-orange-300 text-[10px] font-bold leading-none">
        3
      </span>
    )
  return null
}

function RankingsRow({
  c,
  zec,
  showPct,
  metric,
  isHottest = false,
}: {
  c: MarketCoin
  zec: MarketCoin | null
  showPct: boolean
  metric: RankMetric
  isHottest?: boolean
}) {
  const isZec = c.symbol === "ZEC"
  // Δ math: how much would ZEC's spot price need to change so ZEC's
  // market cap (or FDV — whichever metric is active) crosses this
  // coin's? Holds ZEC supply constant. We derive ZEC's price from
  // marketCap / circulatingSupply so the computation works even when
  // /api/markets is serving via the CoinPaprika fallback (which
  // sometimes omits the `price` field while still populating
  // marketCap + circulatingSupply).
  //
  // FDV mode uses ZEC's circulatingSupply for the price-delta (rather
  // than total supply) because ZEC is fully diluted today — circulating
  // ≈ total — and the user is asking "what spot move pushes ZEC past
  // this competitor on the FDV leaderboard?", which is a question about
  // ZEC's tradeable supply, not its theoretical max.
  let deltaZecPrice: number | null = null
  let deltaPct: number | null = null
  const zecPrice =
    zec?.price ??
    (zec?.marketCap != null &&
    zec?.circulatingSupply != null &&
    zec.circulatingSupply > 0
      ? zec.marketCap / zec.circulatingSupply
      : null)
  const zecMetricValue = zec ? valueFor(zec, metric) : null
  const cMetricValue = valueFor(c, metric)
  if (
    !isZec &&
    zec &&
    zecMetricValue != null &&
    zec.circulatingSupply != null &&
    zec.circulatingSupply > 0 &&
    cMetricValue != null &&
    zecPrice != null &&
    zecPrice > 0
  ) {
    const deltaMcap = cMetricValue - zecMetricValue
    deltaZecPrice = deltaMcap / zec.circulatingSupply
    deltaPct = (deltaZecPrice / zecPrice) * 100
  }
  // Direction: positive delta = competitor is ABOVE ZEC, ZEC needs to
  // gain to overtake. Negative = ZEC is ahead, the competitor would
  // need ZEC to give up that much before being overtaken.
  const ahead = deltaZecPrice != null && deltaZecPrice < 0
  const behind = deltaZecPrice != null && deltaZecPrice > 0
  const change24hUp = (c.change24h ?? 0) >= 0

  const medal = rankBadge(c.rank)
  return (
    <tr
      className={`border-b border-border/20 last:border-b-0 transition-colors ${
        isZec ? "" : "hover:bg-muted/20"
      }`}
      style={
        isZec
          ? {
              // ZEC row: warmer orange wash + a left-edge accent so the
              // eye snaps to it from anywhere in the table. The boxShadow
              // is the trick — table-cell border-left collapses with
              // adjacent borders, but an inset shadow doesn't.
              backgroundColor: `${ZEC_COLOR}14`,
              borderColor: `${ZEC_COLOR}30`,
              boxShadow: `inset 3px 0 0 ${ZEC_COLOR}`,
            }
          : undefined
      }
    >
      <td className="pl-3 pr-1 py-2 text-muted-foreground whitespace-nowrap">
        {isZec ? (
          <span
            className="inline-flex items-center gap-1 font-bold"
            style={{ color: ZEC_COLOR }}
          >
            <Flame className="size-3" aria-hidden="true" />#{c.rank}
          </span>
        ) : medal ? (
          <span className="inline-flex items-center gap-1.5">
            {medal}
            <span className="text-muted-foreground">#{c.rank}</span>
          </span>
        ) : (
          <span>#{c.rank}</span>
        )}
      </td>
      <td className="p-2">
        <div className="flex items-center gap-2 min-w-0">
          <CoinLogo image={c.image} symbol={c.symbol} size={18} />
          <span
            className="font-bold whitespace-nowrap"
            style={isZec ? { color: ZEC_COLOR } : { color: "var(--foreground)" }}
          >
            {c.symbol}
          </span>
          <span className="text-muted-foreground truncate hidden sm:inline">
            {c.name}
          </span>
          {isHottest && !isZec && (
            <span
              className="inline-flex items-center gap-0.5 px-1 rounded text-[9px] font-mono font-bold border border-orange-500/40 bg-orange-500/10 text-orange-300"
              title={`Top 24h gainer in view (${fmtPct(c.change24h)})`}
            >
              <Flame className="size-2.5" aria-hidden="true" />
              HOT
            </span>
          )}
        </div>
      </td>
      <td className="p-2 text-right text-foreground whitespace-nowrap">
        {fmtMcap(cMetricValue)}
      </td>
      <td className="p-2 text-right text-muted-foreground whitespace-nowrap hidden sm:table-cell">
        {fmtPrice(c.price)}
      </td>
      <td className="p-2 text-right whitespace-nowrap">
        {/* Compact pill on mobile, plain text on md+. The pill keeps
            the column scannable when it's competing for narrow width
            with the # / Coin / Mcap columns. */}
        {c.change24h == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span
            className={`inline-flex items-center justify-end gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono whitespace-nowrap md:px-0 md:py-0 md:rounded-none md:text-xs ${
              change24hUp
                ? "text-green-400 bg-green-500/10 md:bg-transparent border border-green-500/30 md:border-0"
                : "text-red-400 bg-red-500/10 md:bg-transparent border border-red-500/30 md:border-0"
            }`}
          >
            {fmtPct(c.change24h)}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        {isZec ? (
          <span className="text-muted-foreground">— here —</span>
        ) : deltaZecPrice == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span
            className="inline-flex items-center gap-0.5"
            style={{ color: ahead ? GOOD : BAD }}
            title={`${
              ahead
                ? `ZEC has a ${fmtMcap(Math.abs(deltaZecPrice * (zec?.circulatingSupply ?? 0)))} market-cap cushion over ${c.symbol}`
                : `ZEC needs ${fmtMcap(Math.abs(deltaZecPrice * (zec?.circulatingSupply ?? 0)))} of market cap to flip ${c.symbol}`
            }${deltaPct != null ? ` (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}% on ZEC's spot price)` : ""}`}
          >
            {ahead ? (
              <ArrowDownRight className="size-3" aria-hidden="true" />
            ) : (
              <ArrowUpRight className="size-3" aria-hidden="true" />
            )}
            {showPct
              ? `${behind ? "+" : ""}${(deltaPct ?? 0).toFixed(1)}%`
              : fmtDeltaCompact(deltaZecPrice)}
          </span>
        )}
      </td>
    </tr>
  )
}

// ─── Supply tab ──────────────────────────────────────────────────────────────

function SupplyTab() {
  const { data, error, isLoading } = useSWR<ZecStats>("/api/zec-stats", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  })

  if (isLoading && !data) {
    return <p className="text-sm text-muted-foreground p-4">Loading…</p>
  }
  if (error || !data) {
    return (
      <p className="text-sm text-destructive-foreground p-4">
        Couldn&rsquo;t load ZEC supply data right now.
      </p>
    )
  }

  // Prefer the cipherscan-provided breakdown when available — it's
  // computed from the chain itself and includes the pool split. Fall
  // back to the legacy single-number shielded total + a derived
  // transparent split for older payloads.
  const breakdown = data.shieldedBreakdown
  const transparent =
    breakdown?.transparent ??
    (data.shielded != null && data.circulating != null
      ? Math.max(data.circulating - data.shielded, 0)
      : null)
  const shieldedPct =
    data.shieldedPct ??
    (data.shielded != null && data.circulating != null && data.circulating > 0
      ? (data.shielded / data.circulating) * 100
      : null)
  const minedPct =
    data.circulating != null && data.max > 0
      ? (data.circulating / data.max) * 100
      : null

  // Compact-ish formatter for circulating supply in the top tile.
  // 16,688,225 → "16.69M". Keeps the tile readable on mobile where
  // the full count would either overflow or have to shrink to a tiny
  // font; the % sub-line preserves the proportional context.
  const fmtSupplyShort = (n: number | null) => {
    if (n == null || !Number.isFinite(n)) return "—"
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`
    if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(0)}K`
    return n.toLocaleString("en-US", { maximumFractionDigits: 0 })
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Top stat grid. Replaces the previous Rank/Price/Mcap/ATH
          layout: ATH moves down to the perf row (less foundational
          than rank/price/mcap, fits cleanly there) and the slot is
          reused for circulating supply, which the user wants up-top
          rather than hidden behind a separate card below the chart.
          Tighter gap on mobile so the 2×2 block reads as a single
          unit rather than four floating tiles. */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-1.5 md:gap-2">
        <SupplyStat
          label="Rank"
          value={data.rank ? `#${data.rank}` : "—"}
          accent={ZEC_COLOR}
        />
        <SupplyStat
          label="Price"
          value={fmtPrice(data.price)}
          sub={data.change24h != null ? `${fmtPct(data.change24h)} 24h` : undefined}
        />
        <SupplyStat label="Market cap" value={fmtMcap(data.marketCap)} />
        <SupplyStat
          label="Circulating"
          value={
            data.circulating != null
              ? `${fmtSupplyShort(data.circulating)} ZEC`
              : "—"
          }
          sub={
            minedPct != null ? `${minedPct.toFixed(1)}% of 21M cap` : undefined
          }
        />
      </section>

      {/* Mcap perf chips + ATH inline. ATH moves here from the top
          grid since "all-time-high vs now" is supplemental context,
          not a foundational stat — perf row is the right home for it
          and frees the top tile for circulating. flex-wrap keeps the
          row readable on narrow viewports: chips wrap first, then ATH
          drops to its own line. */}
      <section className="flex flex-wrap items-center gap-x-3 gap-y-1.5 -mt-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            Mcap perf
          </span>
          <PerfChip label="24h" pct={data.mcapChange24h} />
          <PerfChip label="7D" pct={data.mcapChange7d} />
          <PerfChip label="30D" pct={data.mcapChange30d} />
        </div>
        {data.ath != null && (
          <span
            className="text-[10px] font-mono text-muted-foreground md:ml-auto whitespace-nowrap"
            title="All-time high price"
          >
            ATH{" "}
            <span className="text-foreground/80">{fmtPrice(data.ath)}</span>
            {data.athChangePct != null && (
              <span className="ml-1">({fmtPct(data.athChangePct)})</span>
            )}
          </span>
        )}
      </section>

      {/* Charts: 30d market cap + shielded-supply history. Tabs on
          all viewports — even on desktop, side-by-side would shrink
          each chart below readable width. */}
      <SupplyCharts mcapSeries={data.mcapSeries} />

      {/* Shielded supply card — only rendered when we have live data
          (cipherscan + the long-lived stale mirror make the no-data
          path effectively unreachable, so we don't bother with a
          placeholder). */}
      {data.shielded != null && data.circulating != null && (
        <section className="rounded-lg border border-border bg-card p-3 md:p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-xs font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <ShieldCheck className="size-3.5" />
              Shielded supply
            </h2>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-2xl md:text-3xl font-mono font-bold text-foreground leading-none">
                {fmtCount(Math.round(data.shielded))}
              </span>
              <span className="text-xs font-mono text-muted-foreground">
                ZEC shielded
              </span>
              {shieldedPct != null && (
                <span className="ml-auto text-xs font-mono text-muted-foreground">
                  {shieldedPct.toFixed(2)}% of circulating
                </span>
              )}
            </div>
            {/* Stacked bar: shielded pools (orchard / sapling / sprout /
                lockbox) vs transparent. When a per-pool breakdown is
                available we render each pool as its own segment so the
                user can eyeball the orchard-vs-sapling shift; otherwise
                we fall back to a 2-tone bar. */}
            {shieldedPct != null &&
              (breakdown ? (
                <PoolBar breakdown={breakdown} circulating={data.circulating} />
              ) : (
                <div className="relative h-2 rounded-full bg-secondary overflow-hidden flex">
                  <div
                    className="h-full"
                    style={{
                      width: `${Math.min(shieldedPct, 100)}%`,
                      backgroundColor: GOOD,
                    }}
                  />
                  <div
                    className="h-full"
                    style={{
                      width: `${Math.max(100 - shieldedPct, 0)}%`,
                      backgroundColor: "#475569",
                    }}
                  />
                </div>
              ))}

            {/* Per-pool legend: only shown when cipherscan returned the
                breakdown. Sapling + Orchard are the two live shielded
                pools; Sprout is the legacy original shielded pool
                (effectively retired); Lockbox is the NU6 funding
                stream sink. */}
            {breakdown ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                <PoolLegend
                  name="Orchard"
                  count={breakdown.orchard}
                  pct={
                    data.circulating > 0
                      ? (breakdown.orchard / data.circulating) * 100
                      : 0
                  }
                  color="#34d399"
                />
                <PoolLegend
                  name="Sapling"
                  count={breakdown.sapling}
                  pct={
                    data.circulating > 0
                      ? (breakdown.sapling / data.circulating) * 100
                      : 0
                  }
                  color="#6ee7b7"
                />
                <PoolLegend
                  name="Sprout"
                  count={breakdown.sprout}
                  pct={
                    data.circulating > 0
                      ? (breakdown.sprout / data.circulating) * 100
                      : 0
                  }
                  color="#a7f3d0"
                />
                <PoolLegend
                  name="Lockbox"
                  count={breakdown.lockbox}
                  pct={
                    data.circulating > 0
                      ? (breakdown.lockbox / data.circulating) * 100
                      : 0
                  }
                  color="#fbbf24"
                />
              </div>
            ) : (
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] font-mono text-muted-foreground">
                <span>
                  <span
                    className="inline-block size-1.5 rounded-full mr-1 align-middle"
                    style={{ backgroundColor: GOOD }}
                  />
                  shielded {fmtCount(Math.round(data.shielded))}
                </span>
                <span>
                  <span
                    className="inline-block size-1.5 rounded-full mr-1 align-middle"
                    style={{ backgroundColor: "#475569" }}
                  />
                  transparent{" "}
                  {transparent != null ? fmtCount(Math.round(transparent)) : "—"}
                </span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] font-mono text-muted-foreground/80 pt-1">
              <span>
                Transparent:{" "}
                {transparent != null ? fmtCount(Math.round(transparent)) : "—"} ZEC
              </span>
              {data.shieldedSource && (
                <a
                  href="https://cipherscan.app/network"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                >
                  via cipherscan <ExternalLink className="size-2.5" />
                </a>
              )}
            </div>
          </div>
        </section>
      )}

    </div>
  )
}

function PoolBar({
  breakdown,
  circulating,
}: {
  breakdown: ShieldedBreakdown
  circulating: number
}) {
  if (circulating <= 0) return null
  const pct = (n: number) => Math.max(0, (n / circulating) * 100)
  const orchardPct = pct(breakdown.orchard)
  const saplingPct = pct(breakdown.sapling)
  const sproutPct = pct(breakdown.sprout)
  const lockboxPct = pct(breakdown.lockbox)
  const transparentPct = Math.max(
    0,
    100 - orchardPct - saplingPct - sproutPct - lockboxPct
  )
  return (
    <div
      className="relative h-2 rounded-full bg-secondary overflow-hidden flex"
      role="img"
      aria-label={`Shielded pool breakdown: orchard ${orchardPct.toFixed(1)}%, sapling ${saplingPct.toFixed(1)}%, sprout ${sproutPct.toFixed(2)}%, lockbox ${lockboxPct.toFixed(2)}%, transparent ${transparentPct.toFixed(1)}%`}
    >
      <div
        className="h-full"
        style={{ width: `${orchardPct}%`, backgroundColor: "#34d399" }}
        title={`Orchard ${orchardPct.toFixed(2)}%`}
      />
      <div
        className="h-full"
        style={{ width: `${saplingPct}%`, backgroundColor: "#6ee7b7" }}
        title={`Sapling ${saplingPct.toFixed(2)}%`}
      />
      <div
        className="h-full"
        style={{ width: `${sproutPct}%`, backgroundColor: "#a7f3d0" }}
        title={`Sprout ${sproutPct.toFixed(2)}%`}
      />
      <div
        className="h-full"
        style={{ width: `${lockboxPct}%`, backgroundColor: "#fbbf24" }}
        title={`Lockbox ${lockboxPct.toFixed(2)}%`}
      />
      <div
        className="h-full"
        style={{ width: `${transparentPct}%`, backgroundColor: "#475569" }}
        title={`Transparent ${transparentPct.toFixed(2)}%`}
      />
    </div>
  )
}

function PoolLegend({
  name,
  count,
  pct,
  color,
}: {
  name: string
  count: number
  pct: number
  color: string
}) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span
        className="size-2 rounded-full flex-shrink-0"
        style={{ backgroundColor: color }}
      />
      <div className="flex flex-col min-w-0">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          {name}
        </span>
        <span className="text-xs font-mono text-foreground truncate">
          {fmtCount(Math.round(count))}
        </span>
        <span className="text-[10px] font-mono text-muted-foreground/70">
          {pct.toFixed(pct < 1 ? 2 : 1)}%
        </span>
      </div>
    </div>
  )
}

function SupplyStat({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub?: string
  accent?: string
}) {
  return (
    <div
      // Tighter padding and zero inter-line gap on mobile so the 2×2
      // tile block doesn't dominate the viewport before the user
      // sees the chart. Desktop keeps the original p-3 / gap-0.5.
      className="rounded-lg border bg-card px-2.5 py-1.5 md:p-3 flex flex-col gap-0 md:gap-0.5"
      style={{ borderColor: accent ? `${accent}33` : undefined }}
    >
      <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground leading-tight">
        {label}
      </span>
      <span
        className="text-base md:text-lg font-mono font-bold text-foreground leading-tight"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </span>
      {sub && (
        <span className="text-[10px] font-mono text-muted-foreground leading-tight">
          {sub}
        </span>
      )}
    </div>
  )
}

// ─── Volume tab ──────────────────────────────────────────────────────────────

function VolumeTab() {
  const { data, error, isLoading } = useSWR<ZecStats>(
    "/api/zec-stats",
    fetcher,
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      keepPreviousData: true,
    }
  )

  if (isLoading && !data) {
    return <p className="text-sm text-muted-foreground p-4">Loading…</p>
  }
  if (error || !data) {
    return (
      <p className="text-sm text-destructive-foreground p-4">
        Couldn&rsquo;t load ZEC volume data right now.
      </p>
    )
  }

  const series = data.volumeSeries ?? []
  const volumes = series.map(([, v]) => v).filter((v) => v > 0)
  // Most recent 24h vs trailing 7d / 30d means lets us tell users
  // "today's volume is X% above the 30d average" — a quick "is this
  // unusual?" read.
  const last24h = data.volume24h
  const last30avg =
    volumes.length > 0
      ? volumes.reduce((s, v) => s + v, 0) / volumes.length
      : null
  const last7avg =
    volumes.length >= 7
      ? volumes.slice(-7).reduce((s, v) => s + v, 0) / 7
      : null
  const turnover =
    last24h != null && data.marketCap != null && data.marketCap > 0
      ? (last24h / data.marketCap) * 100
      : null
  const vsAvg30d =
    last24h != null && last30avg != null && last30avg > 0
      ? ((last24h - last30avg) / last30avg) * 100
      : null

  // Build the chart's data array — pair the volume timestamps with the
  // corresponding price points from the mcap series (mcap = price ×
  // supply, so price = mcap / circulating). Falls back to current
  // circulating supply for the price derivation, which is fine for the
  // 30-day window we use here.
  const supply = data.circulating ?? null
  const mcapByTs = new Map<number, number>(
    (data.mcapSeries ?? []).map(([ts, mc]) => [ts, mc])
  )
  const chartData = series
    .filter(([, v]) => v > 0)
    .map(([ts, v]) => {
      const mcap = mcapByTs.get(ts)
      const price =
        mcap != null && supply != null && supply > 0
          ? mcap / supply
          : 0
      return {
        ts,
        date: new Date(ts).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
        volume: v,
        price,
      }
    })

  return (
    <div className="flex flex-col gap-3">
      {/* Top tile grid — same compact treatment as the Supply tab so
          the two read as siblings on mobile. */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-1.5 md:gap-2">
        <SupplyStat
          label="24h volume"
          value={last24h != null ? fmtMcap(last24h) : "—"}
          accent={ZEC_COLOR}
        />
        <SupplyStat
          label="Turnover"
          value={turnover != null ? `${turnover.toFixed(2)}%` : "—"}
          sub="vol ÷ mcap"
        />
        <SupplyStat
          label="30d avg"
          value={last30avg != null ? fmtMcap(last30avg) : "—"}
          sub="daily volume"
        />
        <SupplyStat
          label="24h vs 30d"
          value={
            vsAvg30d != null
              ? `${vsAvg30d >= 0 ? "+" : ""}${vsAvg30d.toFixed(0)}%`
              : "—"
          }
          sub={
            last7avg != null && last24h != null
              ? `7d avg ${fmtMcap(last7avg)}`
              : undefined
          }
        />
      </section>

      <section className="rounded-lg border border-border bg-card flex flex-col">
        <header className="flex items-center justify-between gap-2 px-3 md:px-4 pt-3 pb-2 border-b border-border/40">
          <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            30-day daily volume
          </h3>
          <span className="text-[10px] font-mono text-muted-foreground">
            <span style={{ color: ZEC_COLOR }}>volume</span>
            <span className="opacity-50"> · </span>
            <span style={{ color: "#a78bfa" }}>price</span>
          </span>
        </header>
        <div className="h-48 md:h-64 px-1 md:px-2 py-2">
          {chartData.length > 0 ? (
            <VolumeChart data={chartData} />
          ) : (
            <div className="h-full flex items-center justify-center text-xs font-mono text-muted-foreground">
              No volume data available yet.
            </div>
          )}
        </div>
      </section>

      <p className="text-[10px] font-mono text-muted-foreground/60 leading-relaxed pt-1">
        24h aggregate across all CoinGecko-tracked ZEC pairs. Daily
        candles from CoinGecko&rsquo;s 30-day market chart.
      </p>
    </div>
  )
}
