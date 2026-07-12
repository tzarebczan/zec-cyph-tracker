"use client"

import { useMemo } from "react"
import useSWR from "swr"
import { CornerBox, Skeleton } from "./primitives"
import { fmtCompactNumber, fmtCompactUSD, swrFetcher } from "./format"
import { E_STATIC, paletteVar } from "./theme"

export type RainbowAsset = "btc" | "zec"

interface RainbowPoint {
  timestamp: number
  price: number
}

interface RainbowModel {
  intercept: number
  slope: number
  rSquared: number
  sampleCount: number
  sourceStart: string
  originTimestamp: number
  // Fixed-width rainbow bands in natural-log space (see the API route).
  bandWidth: number
  bandOffset: number
}

interface RainbowResponse {
  asset: RainbowAsset
  history: RainbowPoint[]
  model: RainbowModel
  latestDaily: RainbowPoint
  fetchedAt: number
  source: string
  stale?: boolean
}

const DAY_MS = 86_400_000
const BAND_COUNT = 9
// Canonical blockchaincenter rainbow palette + labels, bottom (cheapest) to
// top (most expensive), so the chart reads like the original chart.
const RAINBOW_COLORS = [
  "#4472c4",
  "#54989f",
  "#63be7b",
  "#b1d580",
  "#feeb84",
  "#f6b45a",
  "#ed7d31",
  "#d64018",
  "#c00200",
]
const RAINBOW_LABELS = [
  "FIRE SALE",
  "BUY",
  "ACCUMULATE",
  "STILL CHEAP",
  "HODL",
  "BUBBLE?",
  "FOMO",
  "SELL",
  "MAX BUBBLE",
]

// The 10 band boundaries as ln offsets from the fitted trend line.
function bandBoundaries(model: RainbowModel): number[] {
  return Array.from(
    { length: BAND_COUNT + 1 },
    (_, index) => (index - (model.bandOffset + 1)) * model.bandWidth
  )
}

function signedPct(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "--"
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`
}

function valueColor(value: number | null): string {
  if (value == null) return paletteVar("text")
  return value >= 0 ? paletteVar("cyph") : E_STATIC.red
}

function ageDays(timestamp: number, originTimestamp: number): number {
  return Math.max(1, (timestamp - originTimestamp) / DAY_MS)
}

function modelPrice(model: RainbowModel, timestamp: number): number {
  return Math.exp(
    model.intercept +
      model.slope * Math.log(ageDays(timestamp, model.originTimestamp))
  )
}

export function PowerLawRainbow({
  asset,
  livePrice,
  isMobile,
  onAssetChange,
  showAssetToggle = false,
  id,
}: {
  asset: RainbowAsset
  livePrice: number | null
  isMobile: boolean
  onAssetChange?: (asset: RainbowAsset) => void
  showAssetToggle?: boolean
  id?: string
}) {
  const { data, error } = useSWR<RainbowResponse>(
    `/api/rainbow?asset=${asset}`,
    swrFetcher,
    { refreshInterval: 1_800_000, keepPreviousData: true }
  )
  const rainbow = data?.asset === asset ? data : null
  const price = livePrice ?? rainbow?.latestDaily.price ?? null
  const current = useMemo(() => {
    if (!rainbow?.model || price == null || price <= 0) return null
    const trend = modelPrice(rainbow.model, Date.now())
    const logDev = Math.log(price / trend)
    const boundaries = bandBoundaries(rainbow.model)
    const minOffset = boundaries[0]
    const maxOffset = boundaries[boundaries.length - 1]
    const band = Math.max(
      0,
      Math.min(
        BAND_COUNT - 1,
        Math.floor((logDev - minOffset) / rainbow.model.bandWidth)
      )
    )
    return {
      band,
      label: RAINBOW_LABELS[band],
      color: RAINBOW_COLORS[band],
      trend,
      vsTrend: ((price - trend) / trend) * 100,
      markerPct: Math.max(
        1,
        Math.min(99, ((logDev - minOffset) / (maxOffset - minOffset)) * 100)
      ),
    }
  }, [price, rainbow])
  const assetLabel = asset.toUpperCase()
  const accent = asset === "btc" ? paletteVar("ratio") : paletteVar("zec")

  return (
    <div id={id} className="scroll-mt-4">
      <CornerBox color={current?.color ?? accent}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[12px] font-bold tracking-[0.2em]">
                {assetLabel} POWER-LAW RAINBOW
              </h2>
              <span
                className="border px-1.5 py-0.5 text-[9px] tracking-[0.14em]"
                style={{ borderColor: `${current?.color ?? accent}66` }}
              >
                LIVE MODEL
              </span>
              {rainbow?.stale && (
                <span className="text-[9px] tracking-[0.14em]" style={{ opacity: 0.55 }}>
                  CACHE
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {showAssetToggle && onAssetChange && (
              <AssetToggle value={asset} onChange={onAssetChange} />
            )}
            {asset === "btc" && (
              <a
                href="https://www.blockchaincenter.net/bitcoin-rainbow-chart/"
                target="_blank"
                rel="noreferrer"
                className="text-[10px] font-bold tracking-[0.14em] underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-1"
                style={{ color: paletteVar("ratio") }}
              >
                ORIGINAL -&gt;
              </a>
            )}
          </div>
        </div>

        {rainbow && current && price != null ? (
          <>
            <div
              className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-y py-3 md:grid-cols-4"
              style={{ borderColor: `${current.color}33` }}
            >
              <RainbowStat label="CURRENT BAND" value={current.label} color={current.color} />
              <RainbowStat label="MODEL TREND" value={fmtCompactUSD(current.trend)} />
              <RainbowStat
                label="VS TREND"
                value={signedPct(current.vsTrend, 1)}
                color={valueColor(current.vsTrend)}
              />
              <RainbowStat
                label="FIT / SAMPLES"
                value={`${(rainbow.model.rSquared * 100).toFixed(1)}% / ${fmtCompactNumber(rainbow.model.sampleCount)}`}
              />
            </div>
            <div className="mt-3">
              <RainbowChart
                asset={asset}
                data={rainbow.history}
                model={rainbow.model}
                livePrice={price}
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
                  left: `${current.markerPct}%`,
                  borderLeft: "4px solid transparent",
                  borderRight: "4px solid transparent",
                  borderTop: `6px solid ${current.color}`,
                }}
              />
              <div
                className="mt-1 flex justify-between text-[9px] tracking-[0.12em]"
                style={{ opacity: 0.55 }}
              >
                <span>FIRE SALE</span>
                <span>HODL</span>
                <span>MAX BUBBLE</span>
              </div>
            </div>
          </>
        ) : error ? (
          <div
            className="flex min-h-40 items-center justify-center text-center text-[11px]"
            style={{ opacity: 0.58 }}
          >
            {assetLabel} rainbow history is temporarily unavailable.
          </div>
        ) : (
          <div className="mt-4">
            <Skeleton height={isMobile ? 250 : 300} />
          </div>
        )}
      </CornerBox>
    </div>
  )
}

function AssetToggle({
  value,
  onChange,
}: {
  value: RainbowAsset
  onChange: (asset: RainbowAsset) => void
}) {
  return (
    <div
      className="inline-flex border"
      style={{ borderColor: `${paletteVar("ratio")}55` }}
      aria-label="Rainbow asset"
    >
      {(["btc", "zec"] as const).map((asset) => {
        const active = value === asset
        const color = asset === "btc" ? paletteVar("ratio") : paletteVar("zec")
        return (
          <button
            key={asset}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(asset)}
            className="min-w-11 px-2 py-1 text-[10px] font-bold tracking-[0.14em] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
            style={{
              color: active ? "#000" : color,
              background: active ? color : "transparent",
              outlineColor: color,
            }}
          >
            {asset.toUpperCase()}
          </button>
        )
      })}
    </div>
  )
}

function RainbowStat({
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

function RainbowChart({
  asset,
  data,
  model,
  livePrice,
  isMobile,
}: {
  asset: RainbowAsset
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
  // Band boundaries are fixed ln offsets from the fitted trend line, so a
  // band edge is simply `trend * exp(offset)` at every point.
  const boundaries = bandBoundaries(model)
  const trendValues = series.map((point) => modelPrice(model, point.timestamp))
  const lowerValues = trendValues.map(
    (trend) => trend * Math.exp(boundaries[0])
  )
  const upperValues = trendValues.map(
    (trend) => trend * Math.exp(boundaries[boundaries.length - 1])
  )
  const minValue = Math.min(...lowerValues, ...series.map((point) => point.price))
  const maxValue = Math.max(...upperValues, ...series.map((point) => point.price))
  const minLog = Math.log10(minValue)
  const maxLog = Math.log10(maxValue)
  const x = (timestamp: number) =>
    padding.left +
    ((timestamp - firstTime) / Math.max(1, lastTime - firstTime)) * innerWidth
  const y = (value: number) =>
    padding.top +
    (1 - (Math.log10(value) - minLog) / Math.max(0.001, maxLog - minLog)) *
      innerHeight
  const linePath = series
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${x(point.timestamp)},${y(point.price)}`
    )
    .join(" ")
  const bandPath = (lowerOffset: number, upperOffset: number) => {
    const upper = series.map((point, index) => {
      const value = trendValues[index] * Math.exp(upperOffset)
      return `${x(point.timestamp)},${y(value)}`
    })
    const lower = [...series].reverse().map((point, reverseIndex) => {
      const index = series.length - 1 - reverseIndex
      const value = trendValues[index] * Math.exp(lowerOffset)
      return `${x(point.timestamp)},${y(value)}`
    })
    return `M${upper.join(" L")} L${lower.join(" L")} Z`
  }
  const yearCount = isMobile ? 4 : 6
  const yearTicks = Array.from({ length: yearCount }, (_, index) => {
    const timestamp =
      firstTime + (index / (yearCount - 1)) * (lastTime - firstTime)
    return { timestamp, label: String(new Date(timestamp).getUTCFullYear()) }
  })
  const minPower = Math.ceil(minLog)
  const maxPower = Math.floor(maxLog)
  const priceTicks = Array.from(
    { length: Math.max(0, maxPower - minPower + 1) },
    (_, index) => 10 ** (minPower + index)
  )
  const dotColor = asset === "btc" ? paletteVar("ratio") : paletteVar("zec")

  return (
    <svg
      role="img"
      aria-label={`${asset.toUpperCase()} price and dynamic power-law rainbow bands`}
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
        fill={dotColor}
        stroke="#000"
        strokeWidth={1.5}
      />
      {yearTicks.map((tick, index) => (
        <text
          key={`${tick.timestamp}-${index}`}
          x={x(tick.timestamp)}
          y={height - 7}
          textAnchor={
            index === 0
              ? "start"
              : index === yearTicks.length - 1
                ? "end"
                : "middle"
          }
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
