"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { CornerBox, Skeleton, useIsMobile } from "./primitives"
import { fmtCompactNumber, fmtCompactUSD, fmtUSD, swrFetcher } from "./format"
import { E_STATIC, paletteVar } from "./theme"
import type { MarketsResponse, PricesResponse } from "./api-types"

type ComparePeriod = "7" | "30" | "90" | "all"

interface RainbowPoint {
  timestamp: number
  price: number
}

interface RainbowModel {
  intercept: number
  slope: number
  sigma: number
  rSquared: number
  fitAtNow: number
  sampleCount: number
  sourceStart: string
}

interface RainbowResponse {
  history: RainbowPoint[]
  model: RainbowModel
  latestDaily: RainbowPoint
  fetchedAt: number
  source: string
  stale?: boolean
}

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

const GENESIS_MS = Date.UTC(2009, 0, 3)
const DAY_MS = 86_400_000
const BTC_MAX_SUPPLY = 21_000_000
const COMPARE_PERIODS: { value: ComparePeriod; label: string }[] = [
  { value: "7", label: "7D" },
  { value: "30", label: "30D" },
  { value: "90", label: "90D" },
  { value: "all", label: "ALL" },
]
const RAINBOW_COLORS = [
  "#60a5fa",
  "#22d3ee",
  "#34d399",
  "#86efac",
  "#fde047",
  "#fbbf24",
  "#fb923c",
  "#f87171",
  "#ef4444",
]
const RAINBOW_LABELS = [
  "DEEP VALUE",
  "VALUE",
  "ACCUMULATE",
  "BELOW TREND",
  "TREND",
  "ABOVE TREND",
  "HOT",
  "VERY HOT",
  "EXTREME",
]

function signedPct(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "--"
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`
}

function valueColor(value: number | null): string {
  if (value == null) return paletteVar("text")
  return value >= 0 ? paletteVar("cyph") : E_STATIC.red
}

function ageDays(timestamp: number): number {
  return Math.max(1, (timestamp - GENESIS_MS) / DAY_MS)
}

function modelPrice(model: RainbowModel, timestamp: number): number {
  return Math.exp(
    model.intercept + model.slope * Math.log(ageDays(timestamp))
  )
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
  const { data: prices, error: pricesError } = useSWR<PricesResponse>(
    "/api/prices?days=all",
    swrFetcher,
    { refreshInterval: 60_000, keepPreviousData: true }
  )
  const { data: markets } = useSWR<MarketsResponse>("/api/markets", swrFetcher, {
    refreshInterval: 300_000,
    keepPreviousData: true,
  })
  const {
    data: rainbow,
    error: rainbowError,
  } = useSWR<RainbowResponse>("/api/bitcoin-rainbow", swrFetcher, {
    refreshInterval: 1_800_000,
    keepPreviousData: true,
  })

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

  const currentRainbow = useMemo(() => {
    if (!rainbow?.model || btcPrice == null || btcPrice <= 0) return null
    const trend = modelPrice(rainbow.model, Date.now())
    const zScore = Math.log(btcPrice / trend) / rainbow.model.sigma
    const band = Math.max(0, Math.min(8, Math.floor((zScore + 2.25) / 0.5)))
    return {
      band,
      label: RAINBOW_LABELS[band],
      color: RAINBOW_COLORS[band],
      trend,
      zScore,
      vsTrend: ((btcPrice - trend) / trend) * 100,
      markerPct: Math.max(1, Math.min(99, ((zScore + 2.25) / 4.5) * 100)),
    }
  }, [btcPrice, rainbow])

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1
            className="text-base font-bold tracking-[0.24em]"
            style={{ color: paletteVar("ratio") }}
          >
            BITCOIN / ZEC
          </h1>
          <span className="text-[11px]" style={{ opacity: 0.58 }}>
            live pair context - relative strength - long-range trend
          </span>
        </div>
        <span className="text-[10px] tracking-[0.16em]" style={{ opacity: 0.55 }}>
          {rainbow?.stale ? "MODEL CACHE" : "LIVE DATA"}
        </span>
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

      <CornerBox color={currentRainbow?.color ?? paletteVar("amber")}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[12px] font-bold tracking-[0.2em]">POWER-LAW RAINBOW</h2>
              <span
                className="border px-1.5 py-0.5 text-[9px] tracking-[0.14em]"
                style={{ borderColor: `${currentRainbow?.color ?? paletteVar("amber")}66` }}
              >
                LIVE MODEL
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-[10px] leading-relaxed" style={{ opacity: 0.58 }}>
              Dynamic power-law regression over Bitcoin daily closes since 2012.
              Bands show distance from trend, not a price forecast.
            </p>
          </div>
          <a
            href="https://www.blockchaincenter.net/bitcoin-rainbow-chart/"
            target="_blank"
            rel="noreferrer"
            className="text-[10px] font-bold tracking-[0.14em] underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-1"
            style={{ color: paletteVar("ratio") }}
          >
            ORIGINAL CHART -&gt;
          </a>
        </div>

        {rainbow && currentRainbow ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-y py-3 md:grid-cols-4" style={{ borderColor: `${currentRainbow.color}33` }}>
              <Stat label="CURRENT BAND" value={currentRainbow.label} color={currentRainbow.color} />
              <Stat label="MODEL TREND" value={fmtCompactUSD(currentRainbow.trend)} />
              <Stat label="VS TREND" value={signedPct(currentRainbow.vsTrend, 1)} color={valueColor(currentRainbow.vsTrend)} />
              <Stat label="FIT / SAMPLES" value={`${(rainbow.model.rSquared * 100).toFixed(1)}% / ${fmtCompactNumber(rainbow.model.sampleCount)}`} />
            </div>
            <div className="mt-3">
              <RainbowChart
                data={rainbow.history}
                model={rainbow.model}
                livePrice={btcPrice ?? rainbow.latestDaily.price}
                isMobile={isMobile}
              />
            </div>
            <div className="relative mt-2 pt-3">
              <div className="grid h-2 grid-cols-9 overflow-hidden">
                {RAINBOW_COLORS.map((color) => (
                  <span key={color} style={{ background: color, opacity: 0.72 }} />
                ))}
              </div>
              <span
                aria-hidden="true"
                className="absolute top-0 h-0 w-0 -translate-x-1/2"
                style={{
                  left: `${currentRainbow.markerPct}%`,
                  borderLeft: "4px solid transparent",
                  borderRight: "4px solid transparent",
                  borderTop: `6px solid ${currentRainbow.color}`,
                }}
              />
              <div className="mt-1 flex justify-between text-[9px] tracking-[0.12em]" style={{ opacity: 0.55 }}>
                <span>DEEP VALUE</span>
                <span>TREND</span>
                <span>EXTREME</span>
              </div>
            </div>
          </>
        ) : rainbowError ? (
          <DataMessage text="Rainbow history is temporarily unavailable. Live BTC/ZEC data remains active." />
        ) : (
          <div className="mt-4"><Skeleton height={isMobile ? 250 : 300} /></div>
        )}
      </CornerBox>

      <CornerBox color={paletteVar("ratio")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[12px] font-bold tracking-[0.2em]">RELATIVE PERFORMANCE</h2>
            <p className="mt-1 text-[10px]" style={{ opacity: 0.55 }}>
              BTC and ZEC rebased to 100 at the start of the selected window.
            </p>
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

        <div className="mt-3 overflow-x-auto">
          <div className="grid min-w-[30rem] grid-cols-[4rem_repeat(3,minmax(0,1fr))] border-y text-[10px] tabular-nums" style={{ borderColor: `${paletteVar("ratio")}33` }}>
            <TableHead text="WINDOW" />
            <TableHead text="BTC" align="right" />
            <TableHead text="ZEC" align="right" />
            <TableHead text="ZEC VS BTC" align="right" />
            {performanceRows.flatMap((row) => [
              <TableCell key={`${row.label}-label`} text={row.label} />,
              <TableCell key={`${row.label}-btc`} text={signedPct(row.btc)} value={row.btc} align="right" />,
              <TableCell key={`${row.label}-zec`} text={signedPct(row.zec)} value={row.zec} align="right" />,
              <TableCell key={`${row.label}-rel`} text={signedPct(row.relative)} value={row.relative} align="right" />,
            ])}
          </div>
        </div>
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

function DataMessage({ text }: { text: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center text-center text-[11px]" style={{ opacity: 0.58 }}>
      {text}
    </div>
  )
}

function TableHead({ text, align = "left" }: { text: string; align?: "left" | "right" }) {
  return (
    <div className={`px-2 py-2 tracking-[0.14em] ${align === "right" ? "text-right" : ""}`} style={{ opacity: 0.55 }}>
      {text}
    </div>
  )
}

function TableCell({
  text,
  value,
  align = "left",
}: {
  text: string
  value?: number | null
  align?: "left" | "right"
}) {
  return (
    <div
      className={`border-t px-2 py-2 font-bold ${align === "right" ? "text-right" : ""}`}
      style={{
        borderColor: `${paletteVar("ratio")}22`,
        color: value == null ? paletteVar("text") : valueColor(value),
      }}
    >
      {text}
    </div>
  )
}

function RainbowChart({
  data,
  model,
  livePrice,
  isMobile,
}: {
  data: RainbowPoint[]
  model: RainbowModel
  livePrice: number
  isMobile: boolean
}) {
  const width = isMobile ? 420 : 1000
  const height = isMobile ? 250 : 300
  const padding = { left: isMobile ? 46 : 58, right: 12, top: 10, bottom: 28 }
  const now = Date.now()
  const series = [...data, { timestamp: now, price: livePrice }]
  const innerWidth = width - padding.left - padding.right
  const innerHeight = height - padding.top - padding.bottom
  const firstTime = series[0]?.timestamp ?? now - DAY_MS
  const lastTime = now
  const boundaries = Array.from({ length: 10 }, (_, index) => -2.25 + index * 0.5)
  const trendValues = series.map((point) => modelPrice(model, point.timestamp))
  const lowerValues = trendValues.map((trend) => trend * Math.exp(boundaries[0] * model.sigma))
  const upperValues = trendValues.map((trend) => trend * Math.exp(boundaries[9] * model.sigma))
  const minValue = Math.min(...lowerValues, ...series.map((point) => point.price))
  const maxValue = Math.max(...upperValues, ...series.map((point) => point.price))
  const minLog = Math.log10(minValue)
  const maxLog = Math.log10(maxValue)
  const x = (timestamp: number) =>
    padding.left + ((timestamp - firstTime) / Math.max(1, lastTime - firstTime)) * innerWidth
  const y = (value: number) =>
    padding.top + (1 - (Math.log10(value) - minLog) / Math.max(0.001, maxLog - minLog)) * innerHeight
  const linePath = series
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(point.timestamp)},${y(point.price)}`)
    .join(" ")
  const bandPath = (lowerZ: number, upperZ: number) => {
    const upper = series.map((point) => {
      const value = modelPrice(model, point.timestamp) * Math.exp(upperZ * model.sigma)
      return `${x(point.timestamp)},${y(value)}`
    })
    const lower = [...series].reverse().map((point) => {
      const value = modelPrice(model, point.timestamp) * Math.exp(lowerZ * model.sigma)
      return `${x(point.timestamp)},${y(value)}`
    })
    return `M${upper.join(" L")} L${lower.join(" L")} Z`
  }
  const yearCount = isMobile ? 4 : 6
  const yearTicks = Array.from({ length: yearCount }, (_, index) => {
    const timestamp = firstTime + (index / (yearCount - 1)) * (lastTime - firstTime)
    return { timestamp, label: String(new Date(timestamp).getUTCFullYear()) }
  })
  const minPower = Math.ceil(minLog)
  const maxPower = Math.floor(maxLog)
  const priceTicks = Array.from(
    { length: Math.max(0, maxPower - minPower + 1) },
    (_, index) => 10 ** (minPower + index)
  )

  return (
    <svg
      role="img"
      aria-label="Bitcoin price and dynamic power-law rainbow bands since 2012"
      viewBox={`0 0 ${width} ${height}`}
      className="block w-full"
      style={{ height }}
    >
      {priceTicks.map((tick) => (
        <g key={tick}>
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={y(tick)}
            y2={y(tick)}
            stroke={paletteVar("text")}
            strokeOpacity={0.12}
            strokeDasharray="2 4"
          />
          <text
            x={padding.left - 6}
            y={y(tick) + 4}
            textAnchor="end"
            fontSize="10"
            fill={paletteVar("text")}
            fillOpacity={0.55}
            fontFamily="ui-monospace, monospace"
          >
            {fmtCompactUSD(tick)}
          </text>
        </g>
      ))}
      {RAINBOW_COLORS.map((color, index) => (
        <path
          key={color}
          d={bandPath(boundaries[index], boundaries[index + 1])}
          fill={color}
          fillOpacity={0.2}
          stroke="none"
        />
      ))}
      <path
        d={linePath}
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.92}
        strokeWidth={1.4}
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={x(now)}
        cy={y(livePrice)}
        r={3.5}
        fill={paletteVar("ratio")}
        stroke="#000"
        strokeWidth={1.5}
      />
      {yearTicks.map((tick, index) => (
        <text
          key={`${tick.timestamp}-${index}`}
          x={x(tick.timestamp)}
          y={height - 7}
          textAnchor={index === 0 ? "start" : index === yearTicks.length - 1 ? "end" : "middle"}
          fontSize="10"
          fill={paletteVar("text")}
          fillOpacity={0.55}
          fontFamily="ui-monospace, monospace"
        >
          {tick.label}
        </text>
      ))}
    </svg>
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
        <span style={{ color: paletteVar("ratio") }}>- BTC {latest.btcIndex.toFixed(1)}</span>
        <span style={{ color: paletteVar("zec") }}>- ZEC {latest.zecIndex.toFixed(1)}</span>
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
