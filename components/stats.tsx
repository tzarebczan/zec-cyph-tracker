"use client"

import { useMemo, useState } from "react"
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
  orchard: "#7dd3fc",
  sapling: "#67e8f9",
  sprout: "#22d3ee",
  lockbox: "#a78bfa",
} as const

// Top-level tab pair: RANKINGS leaderboard vs. ZEC-focused detail
// (with its own sub-tab strip).
type TopTab = "rankings" | "zec"
type ZecSub = "supply" | "shielded" | "shieldedChart" | "transactions"

// Per-pool history endpoint already exposes daily snapshots of the
// shielded supply by pool — see `/api/zec-stats/history` and the
// existing `<SupplyCharts>` consumer. We reuse the same shape here so
// the StackedAreaChart can plot the real numbers.
interface ShieldedHistoryPoint {
  date: string
  total: number
  sapling: number
  orchard: number
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
  fetchedAt: number
  stale?: boolean
}

export function BetaStats() {
  const [tab, setTab] = useState<TopTab>("rankings")
  const [zecSub, setZecSub] = useState<ZecSub>("supply")
  // 360-wide viewBox on mobile keeps SVG axis labels from squishing
  // horizontally; desktop's 900 default already fits the wide chart
  // card so we leave that alone.
  const isMobile = useIsMobile()
  const chartW = isMobile ? 360 : 900
  // Per-chart window selection. Each chart owns its own state so the
  // user can pin SHIELDED CHART to 1Y while keeping TRANSACTIONS on
  // 30D, etc. Defaults are 90D so the first view matches the
  // previous behaviour.
  const [supplyWindow, setSupplyWindow] = useState<ChartWindow>("90D")
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
  // Per-pool history + daily-tx stats lazy-load only when the user
  // navigates into the ZEC tab — keeps the cold-load round trips on
  // RANKINGS down to the leaderboard fetch.
  const { data: shieldedHistory } = useSWR<ShieldedHistoryResponse>(
    tab === "zec" && (zecSub === "shieldedChart" || zecSub === "supply")
      ? "/api/zec-stats/history"
      : null,
    swrFetcher,
    { refreshInterval: 30 * 60_000, keepPreviousData: true }
  )
  const { data: txStats } = useSWR<TxStatsResponse>(
    tab === "zec" && zecSub === "transactions" ? "/api/zec-tx-stats" : null,
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
  const zecSupply = zecCoin?.circulatingSupply ?? zecStats?.circulating ?? null
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

  // Per-pool history, normalized for the chart components. The full
  // upstream series is mapped once; each chart slices its own window
  // off the end below so changing windows doesn't refetch.
  const shieldedAllPoints = useMemo(() => {
    const pts = shieldedHistory?.points ?? []
    return pts.map((p) => ({
      date: p.date.slice(5),
      orchard: p.orchard ?? 0,
      sapling: p.sapling ?? 0,
      sprout: p.sprout ?? 0,
    }))
  }, [shieldedHistory])
  const supplyPoints = useMemo(() => {
    const days = windowSliceDays(supplyWindow)
    return days == null
      ? shieldedAllPoints
      : shieldedAllPoints.slice(-days)
  }, [shieldedAllPoints, supplyWindow])
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
  const txAllPoints = useMemo(() => {
    const days = txStats?.days ?? []
    return days.map((d) => ({
      date: d.date.slice(5),
      total: d.total,
      shielded:
        d.shielding + d.deshielding + d.fullyShielded + d.mixed,
    }))
  }, [txStats])
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
      <div className="flex items-baseline gap-3 mb-3 flex-wrap">
        <h1 className="text-base font-bold tracking-[0.2em]">ZEC STATS</h1>
        <span
          className="text-[10px]"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          Top-50 leaderboard · Zcash supply, shielded pools & transactions
        </span>
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
                className="text-[10px] tracking-[0.3em]"
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
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              {nextCoin && deltaToNextPrice != null && (
                <div
                  className="px-2 py-1 border"
                  style={{ borderColor: `${paletteVar("cyph")}55` }}
                >
                  <div
                    className="text-[9px]"
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
                <div
                  className="px-2 py-1 border"
                  style={{ borderColor: `${paletteVar("ratio")}55` }}
                >
                  <div
                    className="text-[9px]"
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
                </div>
              )}
            </div>
          </div>
        </CornerBox>
      )}

      {/* Top tabs — terminal-style bracket buttons. Active tab gets
          a solid fill + glow + thicker bottom edge so the choice is
          unmistakable; inactive tab keeps the bracket frame but
          dims significantly. Bigger padding + text so the strip
          reads as a primary control rather than a sub-tab. */}
      <div className="flex items-end gap-2 mb-4">
        {(
          [
            ["rankings", "RANKINGS"],
            ["zec", "ZEC"],
          ] as const
        ).map(([v, l]) => {
          const on = tab === v
          return (
            <button
              key={v}
              type="button"
              onClick={() => setTab(v)}
              aria-pressed={on}
              className="relative px-5 py-2 text-[12px] font-bold tracking-[0.2em] transition-all whitespace-nowrap focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
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

      {tab === "rankings" && (
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
          <div className="cz-rank-grid grid gap-0 px-1 py-1 border-b text-[9px] tracking-[0.2em]"
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
                      className="text-[10px] truncate"
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
                    className="text-[10px] text-right tabular-nums"
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

      {tab === "zec" && (
        <>
          {/* ZEC sub-tabs — bracket-style tab strip with visible
              borders on every tab so the row reads as a clearly
              tappable control set. Active tab fills + glows in amber;
              inactive tabs stay outlined but dim. */}
          <div className="flex items-center gap-1 mb-3 overflow-x-auto pb-1">
            {(
              [
                ["supply", "SUPPLY"],
                ["shielded", "SHIELDED"],
                ["shieldedChart", "SHIELDED CHART"],
                ["transactions", "TRANSACTIONS"],
              ] as const
            ).map(([v, l]) => {
              const on = zecSub === v
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => setZecSub(v)}
                  aria-pressed={on}
                  className="border px-3 py-1.5 text-[10px] tracking-[0.15em] font-bold transition-colors whitespace-nowrap focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 hover:opacity-100"
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

          {zecSub === "supply" && (
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
                      className="text-[10px] mt-1"
                      style={{ color: paletteVar("text"), opacity: 0.6 }}
                    >
                      of 21M max supply
                    </div>
                    <div className="mt-3">
                      <BlockProgress
                        pct={(zecSupply / 21e6) * 100}
                        width={28}
                        color={paletteVar("zec")}
                        label="MINED"
                        sub={`${((zecSupply / 21e6) * 100).toFixed(2)}%`}
                      />
                    </div>
                    <div
                      className="text-[10px] mt-2"
                      style={{ color: paletteVar("text"), opacity: 0.6 }}
                    >
                      ~{((21e6 - zecSupply) / 1e6).toFixed(2)}M ZEC remaining to mint
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
              {/* Emission curve — total shielded supply over time
                  from the per-pool history endpoint. Window selector
                  in the card action lets users zoom in (7D) or pan
                  out (ALL); 1D is omitted because the upstream is
                  daily-resolution. */}
              <CornerBox
                label={`EMISSION CURVE · ${supplyWindow}`}
                color={paletteVar("zec")}
                action={
                  <WindowChips
                    value={supplyWindow}
                    onChange={setSupplyWindow}
                    options={["7D", "30D", "90D", "1Y", "ALL"]}
                    color={paletteVar("zec")}
                  />
                }
              >
                {supplyPoints.length >= 2 ? (
                  <SimpleLineChartE
                    data={supplyPoints.map((p) => ({
                      date: p.date,
                      total: p.orchard + p.sapling + p.sprout,
                    }))}
                    accessor={(d) => d.total}
                    color={paletteVar("zec")}
                    height={180}
                    format={(v) => (v / 1e6).toFixed(2) + "M"}
                    label="SHLD"
                    viewBoxWidth={chartW}
                  />
                ) : (
                  <div
                    className="text-[11px] py-12 text-center"
                    style={{ color: paletteVar("text"), opacity: 0.5 }}
                  >
                    {shieldedAllPoints.length === 0
                      ? "Loading per-pool history…"
                      : `Not enough data in ${supplyWindow} — try a longer window.`}
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

          {zecSub === "shielded" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <CornerBox
                label="SHIELDED POOLS"
                color={paletteVar("ratio")}
                action={
                  <a
                    href="https://zechub.wiki/zcashdocs/zcash-overview/shielded-pools"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] tracking-[0.2em] hover:underline"
                    style={{ color: paletteVar("ratio") }}
                  >
                    LEARN →
                  </a>
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
                      className="text-[10px] mt-1"
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
                      <div className="grid grid-cols-4 gap-1 mt-3 text-[9px]">
                        {(() => {
                          const chain =
                            (shielded.transparent ?? 0) +
                            shielded.sprout +
                            shielded.sapling +
                            shielded.orchard +
                            shielded.lockbox
                          const cells = [
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
              {/* Pool breakdown · current — horizontal bars with pool
                  descriptors. Reads like a row legend so users coming
                  off the chart-only sub-tab understand what each
                  pool actually means. */}
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
            </div>
          )}

          {zecSub === "shieldedChart" && (
            <CornerBox
              label={`SHIELDED POOLS · ${shieldedChartWindow}`}
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
                  {/* Orchard → Sapling → Sprout stack order (newest
                      pool on top). Upstream history endpoint doesn't
                      surface Lockbox yet, so the chart shows the three
                      core pools — the Pool Breakdown card on the
                      SHIELDED tab still surfaces Lockbox separately. */}
                  <StackedAreaChart
                    data={shieldedChartPoints}
                    keys={["sprout", "sapling", "orchard"]}
                    colors={[
                      POOL_COLORS.sprout,
                      POOL_COLORS.sapling,
                      POOL_COLORS.orchard,
                    ]}
                    height={isMobile ? 220 : 280}
                    viewBoxWidth={chartW}
                  />
                  <div className="flex flex-wrap gap-3 mt-3 text-[10px]">
                    {(
                      [
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

          {zecSub === "transactions" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
                  className="text-[10px] mt-1"
                  style={{ color: paletteVar("text"), opacity: 0.6 }}
                >
                  of recent daily transactions touch a shielded pool
                </div>
                {lastTx && (
                  <div
                    className="mt-3 text-[10px]"
                    style={{ color: paletteVar("text"), opacity: 0.7 }}
                  >
                    Today:{" "}
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
    orchard: number
    sapling: number
    sprout: number
    lockbox: number
  }
}) {
  const totalShielded =
    shielded.orchard + shielded.sapling + shielded.sprout + shielded.lockbox
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
    ["ORCHARD", shielded.orchard, POOL_COLORS.orchard, "Latest pool · Halo 2 zk-SNARKs"],
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
              className="text-[9px] pl-20"
              style={{ color: paletteVar("text"), opacity: 0.5 }}
            >
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
// that hugs its content, so the pair takes ~140px total at text-[10px].
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
            className="px-2 py-0.5 text-[10px] tracking-[0.1em] font-bold transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
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
