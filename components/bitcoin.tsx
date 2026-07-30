"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { CornerBox, InfoTip, Skeleton, useIsMobile } from "./primitives"
import { usePersistentState } from "@/lib/use-persistent-state"
import { fmtCompactNumber, fmtCompactUSD, fmtUSD, swrFetcher } from "./format"
import { E_STATIC, paletteVar } from "./theme"
import {
  PowerLawRainbow,
  type RainbowAsset,
} from "./power-law-rainbow"
import type { MarketsResponse, PricesResponse } from "./api-types"

type ComparePeriod = "7" | "30" | "90" | "all"

interface PairPoint {
  timestamp: number
  date: string
  btc: number
  zec: number
  ratio: number
}

interface RelativePoint extends PairPoint {
  btcIndex: number
  zecIndex: number
}

const DAY_MS = 86_400_000
const BTC_MAX_SUPPLY = 21_000_000
const COMPARE_PERIODS: { value: ComparePeriod; label: string }[] = [
  { value: "7", label: "7D" },
  { value: "30", label: "30D" },
  { value: "90", label: "90D" },
  { value: "all", label: "ALL" },
]

// BTC price chart windows. `days` maps straight onto /api/prices?days=.
// "1" is the intraday path; "270" (~9M) is registered server-side too.
type SparkPeriod = "1" | "7" | "30" | "90" | "270"
const SPARK_PERIODS: { value: SparkPeriod; label: string }[] = [
  { value: "1", label: "1D" },
  { value: "7", label: "1W" },
  { value: "30", label: "1M" },
  { value: "90", label: "3M" },
  { value: "270", label: "9M" },
]
const SPARK_PERIOD_VALUES = SPARK_PERIODS.map((p) => p.value)
function isSparkPeriod(v: unknown): v is SparkPeriod {
  return typeof v === "string" && (SPARK_PERIOD_VALUES as string[]).includes(v)
}

function signedPct(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "--"
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`
}

function valueColor(value: number | null): string {
  if (value == null) return paletteVar("text")
  return value >= 0 ? paletteVar("cyph") : E_STATIC.red
}

function pairHistory(prices: PricesResponse | undefined): PairPoint[] {
  const rows = (prices?.history ?? []).flatMap((point) => {
    if (
      point.btc == null ||
      !Number.isFinite(point.btc) ||
      point.btc <= 0 ||
      !Number.isFinite(point.zec) ||
      point.zec <= 0
    ) {
      return []
    }
    return [{
      timestamp: point.timestamp,
      date: point.date,
      btc: point.btc,
      zec: point.zec,
      ratio: point.zec / point.btc,
    }]
  })

  const btc = prices?.current?.btc?.price
  const zec = prices?.current?.zec?.price
  if (btc != null && btc > 0 && zec != null && zec > 0) {
    const last = rows[rows.length - 1]
    if (!last || last.btc !== btc || last.zec !== zec) {
      rows.push({
        timestamp: Date.now(),
        date: "LIVE",
        btc,
        zec,
        ratio: zec / btc,
      })
    }
  }
  return rows
}

function pointAtWindow(points: PairPoint[], days: number): PairPoint | null {
  if (!points.length) return null
  const target = Date.now() - days * DAY_MS
  let best: PairPoint | null = null
  for (const point of points) {
    if (point.timestamp <= target) best = point
    else break
  }
  return best ?? points[0]
}

function pctChange(current: number, previous: number | null | undefined): number | null {
  return previous != null && previous > 0
    ? ((current - previous) / previous) * 100
    : null
}

function formatRatio(value: number | null): string {
  if (value == null) return "--"
  return value < 0.001 ? value.toFixed(7) : value.toFixed(6)
}

export function BitcoinZec() {
  const isMobile = useIsMobile()
  const [period, setPeriod] = useState<ComparePeriod>("90")
  const [rainbowAsset, setRainbowAsset] = useState<RainbowAsset>("btc")
  const { data: prices, error: pricesError } = useSWR<PricesResponse>(
    "/api/prices?days=all",
    swrFetcher,
    { refreshInterval: 60_000, keepPreviousData: true }
  )
  const { data: markets } = useSWR<MarketsResponse>("/api/markets", swrFetcher, {
    refreshInterval: 300_000,
    keepPreviousData: true,
  })

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("rainbow") === "zec") {
      setRainbowAsset("zec")
    }
  }, [])

  const history = useMemo(() => pairHistory(prices), [prices])
  const latest = history[history.length - 1] ?? null
  const btcMarket = markets?.coins.find((coin) => coin.symbol === "BTC")
  const zecMarket = markets?.coins.find((coin) => coin.symbol === "ZEC")
  const btcPrice = latest?.btc ?? prices?.current?.btc?.price ?? null
  const zecPrice = latest?.zec ?? prices?.current?.zec?.price ?? null
  const zecBtc = latest?.ratio ?? null
  const satsPerZec = zecBtc != null ? zecBtc * 100_000_000 : null
  const supplyMined =
    btcMarket?.circulatingSupply != null
      ? (btcMarket.circulatingSupply / BTC_MAX_SUPPLY) * 100
      : null

  const comparison = useMemo(() => {
    if (!latest) return null
    const previous = pointAtWindow(history, 30)
    return {
      btc30: pctChange(latest.btc, previous?.btc),
      zec30: pctChange(latest.zec, previous?.zec),
      ratio30: pctChange(latest.ratio, previous?.ratio),
    }
  }, [history, latest])

  const performanceRows = useMemo(() => {
    if (!latest) return []
    return [1, 7, 30, 90].map((days) => {
      const previous = pointAtWindow(history, days)
      return {
        label: days === 1 ? "24H" : `${days}D`,
        btc: pctChange(latest.btc, previous?.btc),
        zec: pctChange(latest.zec, previous?.zec),
        relative: pctChange(latest.ratio, previous?.ratio),
      }
    })
  }, [history, latest])

  const relativeSeries = useMemo<RelativePoint[]>(() => {
    if (history.length < 2) return []
    const cutoff =
      period === "all" ? -Infinity : Date.now() - Number(period) * DAY_MS
    const selected = history.filter((point) => point.timestamp >= cutoff)
    const points = selected.length >= 2 ? selected : history.slice(-2)
    const base = points[0]
    return points.map((point) => ({
      ...point,
      btcIndex: (point.btc / base.btc) * 100,
      zecIndex: (point.zec / base.zec) * 100,
    }))
  }, [history, period])

  return (
    <div className="space-y-3">
      <header>
        <h1
          className="text-base font-bold tracking-[0.24em]"
          style={{ color: paletteVar("ratio") }}
        >
          BITCOIN / ZEC
        </h1>
      </header>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <CornerBox color={paletteVar("ratio")}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-bold tracking-[0.2em]">BITCOIN</span>
            <span
              className="border px-1.5 py-0.5 text-[9px] tracking-[0.16em]"
              style={{ borderColor: `${paletteVar("ratio")}66` }}
            >
              BTC / USD
            </span>
          </div>
          <div
            className="mt-3 text-3xl font-bold leading-none tabular-nums md:text-4xl"
            style={{ color: paletteVar("ratio") }}
          >
            {btcPrice != null ? fmtUSD(btcPrice, { maxFrac: 0, minFrac: 0 }) : <Skeleton height={36} />}
          </div>
          <div
            className="mt-1 text-[11px] tabular-nums"
            style={{ color: valueColor(prices?.current?.btc?.change24h ?? null) }}
          >
            {signedPct(prices?.current?.btc?.change24h ?? null)} 24H
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3">
            <Stat label="MARKET CAP" value={fmtCompactUSD(btcMarket?.marketCap)} />
            <Stat
              label="CIRCULATING"
              value={fmtCompactNumber(btcMarket?.circulatingSupply) + " BTC"}
            />
            <Stat label="MAX SUPPLY" value="21.00M BTC" />
            <Stat label="MINED" value={supplyMined != null ? `${supplyMined.toFixed(2)}%` : "--"} />
          </div>
        </CornerBox>

        <CornerBox color={paletteVar("zec")}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-bold tracking-[0.2em]">ZEC / BTC</span>
            <span
              className="border px-1.5 py-0.5 text-[9px] tracking-[0.16em]"
              style={{ borderColor: `${paletteVar("zec")}66` }}
            >
              LIVE PAIR
            </span>
          </div>
          <div
            className="mt-3 text-3xl font-bold leading-none tabular-nums md:text-4xl"
            style={{ color: paletteVar("zec") }}
          >
            {formatRatio(zecBtc)}
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[12px] font-bold tabular-nums" style={{ color: paletteVar("ratio") }}>
              {satsPerZec != null ? `${fmtCompactNumber(satsPerZec)} SATS / ZEC` : "-- SATS / ZEC"}
            </span>
            <span className="text-[10px] tabular-nums" style={{ color: valueColor(comparison?.ratio30 ?? null) }}>
              {signedPct(comparison?.ratio30 ?? null)} VS 30D
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3">
            <Stat label="ZEC SPOT" value={fmtUSD(zecPrice)} color={paletteVar("zec")} />
            <Stat label="ZEC MCAP" value={fmtCompactUSD(zecMarket?.marketCap)} />
            <Stat label="BTC 30D" value={signedPct(comparison?.btc30 ?? null)} color={valueColor(comparison?.btc30 ?? null)} />
            <Stat label="ZEC 30D" value={signedPct(comparison?.zec30 ?? null)} color={valueColor(comparison?.zec30 ?? null)} />
          </div>
        </CornerBox>
      </section>

      <BtcPriceChart isMobile={isMobile} livePrice={btcPrice} />

      <PowerLawRainbow
        asset={rainbowAsset}
        livePrice={rainbowAsset === "btc" ? btcPrice : zecPrice}
        isMobile={isMobile}
        onAssetChange={setRainbowAsset}
        showAssetToggle
      />

      <CornerBox color={paletteVar("ratio")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <h2 className="text-[12px] font-bold tracking-[0.2em]">RELATIVE PERFORMANCE</h2>
            <InfoTip
              align="center"
              color={paletteVar("ratio")}
              label="About relative performance"
              size={14}
            >
              BTC and ZEC are rebased to 100 at the start of the selected window so
              their relative performance can be compared on the same scale.
            </InfoTip>
          </div>
          <div className="inline-flex border" style={{ borderColor: `${paletteVar("ratio")}55` }}>
            {COMPARE_PERIODS.map((option) => {
              const active = option.value === period
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setPeriod(option.value)}
                  className="min-w-10 px-2 py-1 text-[10px] font-bold tracking-[0.12em] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                  style={{
                    color: active ? "#000" : paletteVar("ratio"),
                    background: active ? paletteVar("ratio") : "transparent",
                    outlineColor: paletteVar("ratio"),
                  }}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>

        {relativeSeries.length >= 2 ? (
          <RelativeChart data={relativeSeries} isMobile={isMobile} />
        ) : pricesError ? (
          <DataMessage text="Live comparison data is temporarily unavailable." />
        ) : (
          <div className="mt-4"><Skeleton height={220} /></div>
        )}

        <PerformanceComparisonTable rows={performanceRows} />
      </CornerBox>
    </div>
  )
}

function Stat({
  label,
  value,
  color,
}: {
  label: string
  value: string
  color?: string
}) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] tracking-[0.16em]" style={{ opacity: 0.55 }}>
        {label}
      </div>
      <div
        className="mt-1 truncate text-[12px] font-bold tabular-nums"
        title={value}
        style={{ color: color ?? paletteVar("text") }}
      >
        {value}
      </div>
    </div>
  )
}

interface BtcChartPoint {
  price: number
  /** unix-ms timestamp. x-axis labels are formatted from this in the browser
   *  (viewer's timezone) rather than reusing /api/prices' server-preformatted
   *  `date` string, which is built server-side (UTC on Cloudflare) and would
   *  show US users UTC intraday times on the 1D window. */
  t: number
}

function BtcPriceChart({
  isMobile,
  livePrice,
}: {
  isMobile: boolean
  livePrice: number | null
}) {
  // Persist the user's selected window across visits/refreshes.
  const [period, setPeriod] = usePersistentState<SparkPeriod>(
    "cyphzec.bitcoin.chartPeriod",
    "90",
    isSparkPeriod
  )
  const { data, error } = useSWR<PricesResponse>(
    `/api/prices?days=${period}`,
    swrFetcher,
    { refreshInterval: 60_000, keepPreviousData: true }
  )
  const points = useMemo<BtcChartPoint[]>(() => {
    const byTimestamp = new Map<number, BtcChartPoint>()
    for (const point of data?.history ?? []) {
      if (
        point.btc == null ||
        !Number.isFinite(point.btc) ||
        point.btc <= 0 ||
        !Number.isFinite(point.timestamp)
      ) {
        continue
      }
      byTimestamp.set(point.timestamp, {
        price: point.btc,
        t: point.timestamp,
      })
    }
    let rows = [...byTimestamp.values()].sort((a, b) => a.t - b.t)

    // Payloads cached before the intraday coverage fix can contain one daily
    // BTC close repeated across most of the window, followed by a few real
    // candles. Drop that synthetic prefix while those caches age out.
    if (period === "1" && rows.length > 2) {
      const firstPrice = rows[0].price
      const firstChange = rows.findIndex(
        (point) => Math.abs(point.price - firstPrice) > 1e-9
      )
      if (
        firstChange > 1 &&
        rows[firstChange].t - rows[0].t >= 2 * 3600_000
      ) {
        rows = rows.slice(firstChange - 1)
      }
    }

    // Keep the live BTC spot as the trailing point so the chart tracks the
    // ticker between /api/prices refreshes.
    const live = livePrice ?? data?.current?.btc?.price
    if (live != null && Number.isFinite(live) && live > 0) {
      const last = rows[rows.length - 1]
      const liveTimestamp = Math.max(Date.now(), (last?.t ?? 0) + 1)
      if (
        !last ||
        last.price !== live ||
        liveTimestamp - last.t >= 30_000
      ) {
        rows.push({
          price: live,
          t: liveTimestamp,
        })
      }
    }
    return rows
  }, [data, livePrice, period])

  const last = points[points.length - 1]?.price ?? null
  const first = points[0]?.price ?? null
  const change =
    first != null && last != null && first > 0
      ? ((last - first) / first) * 100
      : null
  const changeColor = valueColor(change)
  const activeLabel =
    SPARK_PERIODS.find((p) => p.value === period)?.label ?? ""
  const ratio = paletteVar("ratio")
  const chartHeight = isMobile ? 150 : 210

  return (
    <CornerBox color={ratio}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[12px] font-bold tracking-[0.2em]">BTC PRICE</h2>
          {last != null && (
            <span
              className="text-[15px] font-bold tabular-nums"
              style={{ color: ratio }}
            >
              {fmtUSD(last, { maxFrac: 0, minFrac: 0 })}
            </span>
          )}
          {change != null && (
            <span className="text-[11px] font-bold tabular-nums" style={{ color: changeColor }}>
              {signedPct(change)} {activeLabel}
            </span>
          )}
        </div>
        <div className="inline-flex border" style={{ borderColor: `${ratio}55` }}>
          {SPARK_PERIODS.map((option) => {
            const active = option.value === period
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => setPeriod(option.value)}
                className="min-w-10 px-2 py-1 text-[10px] font-bold tracking-[0.12em] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                style={{
                  color: active ? "#000" : ratio,
                  background: active ? ratio : "transparent",
                  outlineColor: ratio,
                }}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="mt-3">
        {points.length >= 2 ? (
          <BtcLineChart
            points={points}
            isMobile={isMobile}
            color={ratio}
            up={change == null || change >= 0}
            intraday={period === "1"}
          />
        ) : error ? (
          <DataMessage text="BTC price history is temporarily unavailable." />
        ) : (
          <Skeleton height={chartHeight} />
        )}
      </div>
    </CornerBox>
  )
}

// Single-series BTC price line chart: log-free linear axis padded to the
// window's own min/max, with a soft area fill, price gridlines on the left
// and time/date labels on the bottom. Deliberately a "real" chart (axes +
// labels) rather than a bare sparkline.
function BtcLineChart({
  points,
  isMobile,
  color,
  up,
  intraday,
}: {
  points: BtcChartPoint[]
  isMobile: boolean
  color: string
  up: boolean
  intraday: boolean
}) {
  // Format x-axis ticks in the viewer's timezone. Intraday (1D) shows wall-
  // clock time, longer windows show the date; the trailing live point is NOW.
  const fmtTick = (point: BtcChartPoint, isLast: boolean): string => {
    if (isLast) return "NOW"
    const d = new Date(point.t)
    if (Number.isNaN(d.getTime())) return ""
    return intraday
      ? d.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  }
  const width = isMobile ? 380 : 960
  const height = isMobile ? 150 : 210
  const padding = {
    left: isMobile ? 50 : 60,
    right: 14,
    top: 14,
    bottom: 22,
  }
  const innerW = width - padding.left - padding.right
  const innerH = height - padding.top - padding.bottom
  const n = points.length
  const firstTime = points[0].t
  const lastTime = points[n - 1].t
  const timeSpan = Math.max(1, lastTime - firstTime)
  const prices = points.map((p) => p.price)
  const minV = Math.min(...prices)
  const maxV = Math.max(...prices)
  const span = maxV - minV
  // Pad the domain so a flat/quiet window doesn't render as a hairline on the
  // axis floor, and a single outlier doesn't dominate the whole height.
  const pad = span > 0 ? span * 0.12 : Math.max(maxV * 0.004, 1)
  const low = minV - pad
  const high = maxV + pad
  const x = (point: BtcChartPoint) =>
    padding.left + ((point.t - firstTime) / timeSpan) * innerW
  const y = (v: number) =>
    padding.top + (1 - (v - low) / Math.max(1e-9, high - low)) * innerH
  const line = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${x(point).toFixed(1)},${y(point.price).toFixed(1)}`
    )
    .join(" ")
  const baseY = padding.top + innerH
  const area = `${line} L${x(points[n - 1]).toFixed(1)},${baseY} L${x(points[0]).toFixed(1)},${baseY} Z`
  const gradientId = `btc-price-fill-${isMobile ? "m" : "d"}`
  const yTicks = [high, (low + high) / 2, low]
  const midpointTime = firstTime + timeSpan / 2
  const midpointIndex = points.reduce(
    (best, point, index) =>
      Math.abs(point.t - midpointTime) <
      Math.abs(points[best].t - midpointTime)
        ? index
        : best,
    0
  )
  const xIdx =
    n <= 1
      ? [0]
      : Array.from(new Set([0, midpointIndex, n - 1]))
  const text = paletteVar("text")

  return (
    <svg
      role="img"
      aria-label="Bitcoin price over the selected window"
      viewBox={`0 0 ${width} ${height}`}
      className="block w-full"
      style={{ height }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.24} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {yTicks.map((tick, i) => (
        <g key={i}>
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={y(tick)}
            y2={y(tick)}
            stroke={text}
            strokeOpacity={0.1}
            strokeDasharray="1 5"
          />
          <text
            x={padding.left - 6}
            y={y(tick) + 3}
            textAnchor="end"
            fontSize="10"
            fill={text}
            fillOpacity={0.5}
            fontFamily="ui-monospace, monospace"
          >
            {fmtCompactUSD(tick)}
          </text>
        </g>
      ))}
      <path d={area} fill={`url(#${gradientId})`} stroke="none" />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={x(points[n - 1])}
        cy={y(points[n - 1].price)}
        r={3}
        fill={up ? color : E_STATIC.red}
        stroke="#000"
        strokeWidth={1}
      />
      {xIdx.map((idx, i) => (
        <text
          key={idx}
          x={x(points[idx])}
          y={height - 6}
          textAnchor={
            i === 0 ? "start" : i === xIdx.length - 1 ? "end" : "middle"
          }
          fontSize="10"
          fill={text}
          fillOpacity={0.55}
          fontFamily="ui-monospace, monospace"
        >
          {fmtTick(points[idx], idx === n - 1)}
        </text>
      ))}
    </svg>
  )
}

function DataMessage({ text }: { text: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center text-center text-[11px]" style={{ opacity: 0.58 }}>
      {text}
    </div>
  )
}

// The leading asset's true outperformance. When BTC leads (the ZEC/BTC ratio
// fell) its gain is the reciprocal move, not |relative| — percentage moves are
// asymmetric (a 50% ratio drop means BTC rose 100% against ZEC).
function leadMagnitude(relative: number | null): number | null {
  if (relative == null) return null
  return relative >= 0 ? relative : (1 / (1 + relative / 100) - 1) * 100
}

function PerformanceComparisonTable({
  rows,
}: {
  rows: {
    label: string
    btc: number | null
    zec: number | null
    relative: number | null
  }[]
}) {
  const maxMove = Math.max(
    1,
    ...rows.map((row) => Math.abs(leadMagnitude(row.relative) ?? 0))
  )

  return (
    <div className="mt-4 border-y text-[10px] tabular-nums" style={{ borderColor: `${paletteVar("ratio")}33` }}>
      <div
        className="grid grid-cols-[3.2rem_1fr_1fr_1.55fr] gap-2 px-2 py-2 tracking-[0.14em]"
        style={{ opacity: 0.55 }}
      >
        <span>WINDOW</span>
        <span className="text-right">BTC</span>
        <span className="text-right">ZEC</span>
        <span className="text-right">LEADER</span>
      </div>
      {rows.map((row) => {
        const relative = row.relative
        const zecLeads = relative != null && relative >= 0
        const leader = relative == null ? "--" : zecLeads ? "ZEC" : "BTC"
        const leaderColor = zecLeads ? paletteVar("zec") : paletteVar("ratio")
        const magnitude = leadMagnitude(relative)
        const width = magnitude == null ? 0 : Math.max(2, (Math.abs(magnitude) / maxMove) * 50)
        return (
          <div
            key={row.label}
            className="grid grid-cols-[3.2rem_1fr_1fr_1.55fr] gap-x-2 gap-y-1 border-t px-2 py-2"
            style={{ borderColor: `${paletteVar("ratio")}22` }}
          >
            <span className="font-bold" style={{ color: paletteVar("text") }}>{row.label}</span>
            <span className="text-right font-bold" style={{ color: valueColor(row.btc) }}>
              {signedPct(row.btc)}
            </span>
            <span className="text-right font-bold" style={{ color: valueColor(row.zec) }}>
              {signedPct(row.zec)}
            </span>
            <span className="whitespace-nowrap text-right font-bold" style={{ color: relative == null ? paletteVar("text") : leaderColor }}>
              {magnitude == null ? "--" : `${leader} ${signedPct(magnitude)}`}
            </span>
            <div className="relative col-span-4 h-1.5" style={{ background: `${paletteVar("text")}12` }}>
              <span
                aria-hidden="true"
                className="absolute bottom-[-2px] left-1/2 top-[-2px] w-px"
                style={{ background: `${paletteVar("text")}44` }}
              />
              {relative != null && (
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0"
                  style={{
                    background: leaderColor,
                    left: zecLeads ? "50%" : `${50 - width}%`,
                    width: `${width}%`,
                    opacity: 0.85,
                  }}
                />
              )}
            </div>
          </div>
        )
      })}
      <div className="flex items-center justify-between gap-3 px-2 py-1.5 text-[9px] tracking-[0.1em]" style={{ opacity: 0.52 }}>
        <span style={{ color: paletteVar("ratio") }}>BTC LEAD</span>
        <span>PARITY</span>
        <span style={{ color: paletteVar("zec") }}>ZEC LEAD</span>
      </div>
    </div>
  )
}

function RelativeChart({ data, isMobile }: { data: RelativePoint[]; isMobile: boolean }) {
  const width = isMobile ? 420 : 1000
  const height = 220
  const padding = { left: 42, right: 12, top: 22, bottom: 28 }
  const innerWidth = width - padding.left - padding.right
  const innerHeight = height - padding.top - padding.bottom
  const values = data.flatMap((point) => [point.btcIndex, point.zecIndex])
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const rangePad = Math.max(2, (maxValue - minValue) * 0.1)
  const low = minValue - rangePad
  const high = maxValue + rangePad
  const x = (index: number) => padding.left + (index / Math.max(1, data.length - 1)) * innerWidth
  const y = (value: number) => padding.top + (1 - (value - low) / Math.max(0.001, high - low)) * innerHeight
  const path = (key: "btcIndex" | "zecIndex") =>
    data.map((point, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(point[key])}`).join(" ")
  const latest = data[data.length - 1]

  return (
    <div className="mt-3">
      <div className="flex items-center gap-4 text-[10px] font-bold tracking-[0.12em]">
        <span className="inline-flex items-center gap-1.5" style={{ color: paletteVar("ratio") }}>
          <span className="inline-block w-5 border-t-2" aria-hidden="true" />
          BTC {latest.btcIndex.toFixed(1)}
        </span>
        <span className="inline-flex items-center gap-1.5" style={{ color: paletteVar("zec") }}>
          <span className="inline-block w-5 border-t-2" aria-hidden="true" />
          ZEC {latest.zecIndex.toFixed(1)}
        </span>
      </div>
      <svg
        role="img"
        aria-label="Bitcoin and ZEC normalized relative performance"
        viewBox={`0 0 ${width} ${height}`}
        className="mt-1 block w-full"
        style={{ height }}
      >
        {[low, 100, high].map((tick) => (
          <g key={tick}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke={paletteVar("text")}
              strokeOpacity={tick === 100 ? 0.28 : 0.1}
              strokeDasharray={tick === 100 ? "3 3" : "1 5"}
            />
            <text
              x={padding.left - 6}
              y={y(tick) + 4}
              textAnchor="end"
              fontSize="10"
              fill={paletteVar("text")}
              fillOpacity={0.5}
              fontFamily="ui-monospace, monospace"
            >
              {tick.toFixed(0)}
            </text>
          </g>
        ))}
        <path d={path("btcIndex")} fill="none" stroke={paletteVar("ratio")} strokeWidth={1.8} vectorEffect="non-scaling-stroke" />
        <path d={path("zecIndex")} fill="none" stroke={paletteVar("zec")} strokeWidth={1.8} vectorEffect="non-scaling-stroke" />
        <circle cx={x(data.length - 1)} cy={y(latest.btcIndex)} r={3} fill={paletteVar("ratio")} />
        <circle cx={x(data.length - 1)} cy={y(latest.zecIndex)} r={3} fill={paletteVar("zec")} />
        <text x={padding.left} y={height - 7} fontSize="10" fill={paletteVar("text")} fillOpacity={0.55} fontFamily="ui-monospace, monospace">
          {data[0].date}
        </text>
        <text x={width - padding.right} y={height - 7} textAnchor="end" fontSize="10" fill={paletteVar("text")} fillOpacity={0.55} fontFamily="ui-monospace, monospace">
          {latest.date}
        </text>
      </svg>
    </div>
  )
}
