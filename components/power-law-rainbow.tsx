"use client"

import { useMemo } from "react"
import useSWR from "swr"
import { CornerBox, Skeleton } from "./primitives"
import { fmtCompactNumber, fmtCompactUSD, swrFetcher } from "./format"
import { E_STATIC, paletteVar, withAlpha } from "./theme"

export type RainbowAsset = "btc" | "zec" | "zecbtc"
type Denomination = "usd" | "btc"
type Orientation = "classic" | "inverted"

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
  denomination: Denomination
  orientation: Orientation
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
// Canonical blockchaincenter rainbow palette, bottom (cheapest) to top (most
// expensive). Blue always marks the end of the scale a holder wants to be at;
// which end that is depends on which way the trend runs, so the inverted
// reading reverses the colours rather than inventing a second palette.
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
const CLASSIC_LABELS = [
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
// The inverted reading is not a valuation scale, so it does not borrow
// valuation words. Against a decaying trend, distance below the fit is the
// decay running on schedule or faster; distance above it is the decay
// breaking. Bottom to top, same as the classic labels.
const DECAY_LABELS = [
  "CAPITULATION",
  "BLEEDING",
  "DECAYING",
  "BASING",
  "ON TREND",
  "FIRMING",
  "BREAKOUT",
  "REPRICING",
  "ESCAPE VELOCITY",
]

const ASSET_META: Record<
  RainbowAsset,
  { label: string; toggle: string; token: "ratio" | "zec" | "cyph" }
> = {
  btc: { label: "BTC", toggle: "BTC", token: "ratio" },
  zec: { label: "ZEC", toggle: "ZEC", token: "zec" },
  zecbtc: { label: "ZEC/BTC", toggle: "ZEC/BTC", token: "cyph" },
}

/** Colours and labels for a model, bottom band to top band. */
function scale(orientation: Orientation): { colors: string[]; labels: string[] } {
  return orientation === "inverted"
    ? { colors: [...RAINBOW_COLORS].reverse(), labels: DECAY_LABELS }
    : { colors: RAINBOW_COLORS, labels: CLASSIC_LABELS }
}

// The 10 band boundaries as ln offsets from the fitted trend line.
function bandBoundaries(model: RainbowModel): number[] {
  return Array.from(
    { length: BAND_COUNT + 1 },
    (_, index) => (index - (model.bandOffset + 1)) * model.bandWidth
  )
}

/** ZEC/BTC spends most of its life in the thousandths of a bitcoin, where
 *  decimal notation is unreadable on an axis. Sats keep every tick a plain
 *  integer with a suffix. */
function fmtValue(value: number, denomination: Denomination): string {
  if (denomination === "btc") return `${fmtCompactNumber(value * 1e8)} sats`
  return fmtCompactUSD(value)
}

/** Axis ticks are exact powers of ten (or 3x one), so the compact
 *  formatters' fixed two decimals are always ".00" — dead width in a gutter
 *  that has to fit "100M sats" at 390px. */
function fmtTick(value: number, denomination: Denomination): string {
  return fmtValue(value, denomination).replace(".00", "")
}

/** Width of the y-axis gutter. Sats labels run to "100M sats"; dollar labels
 *  stop at "$100K". */
function axisGutter(denomination: Denomination, isMobile: boolean): number {
  if (denomination === "btc") return isMobile ? 62 : 70
  return isMobile ? 46 : 58
}

function signedPct(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "--"
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`
}

/** Green for the side of the trend a holder wants to be on. That is above the
 *  line for a rising fit and, once the colours invert, still above the line
 *  for a decaying one — so this follows the price, not the orientation. */
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
  assetOptions,
  id,
}: {
  asset: RainbowAsset
  livePrice: number | null
  isMobile: boolean
  onAssetChange?: (asset: RainbowAsset) => void
  /** Which assets the toggle offers. Omit to hide the toggle entirely. */
  assetOptions?: readonly RainbowAsset[]
  id?: string
}) {
  // `schema` busts the edge/browser/SW HTTP cache on a model-shape change.
  // The route only reads `asset`, but the URL is the CDN cache key and it
  // advertises stale-while-revalidate, so without a version bump a freshly
  // deployed client could be served an old-schema body (no denomination or
  // orientation) and render the wrong palette. Bump on any model change.
  const { data, error } = useSWR<RainbowResponse>(
    `/api/rainbow?asset=${asset}&schema=3`,
    swrFetcher,
    { refreshInterval: 1_800_000, keepPreviousData: true }
  )
  const rainbow = data?.asset === asset ? data : null
  const price = livePrice ?? rainbow?.latestDaily.price ?? null
  const current = useMemo(() => {
    if (!rainbow?.model || price == null || price <= 0) return null
    const { colors, labels } = scale(rainbow.model.orientation)
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
      colors,
      labels,
      label: labels[band],
      color: colors[band],
      trend,
      vsTrend: ((price - trend) / trend) * 100,
      markerPct: Math.max(
        1,
        Math.min(99, ((logDev - minOffset) / (maxOffset - minOffset)) * 100)
      ),
    }
  }, [price, rainbow])
  const meta = ASSET_META[asset]
  const accent = paletteVar(meta.token)

  return (
    <div id={id} className="scroll-mt-4">
      <CornerBox color={current?.color ?? accent}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[12px] font-bold tracking-[0.2em]">
                {meta.label} POWER-LAW RAINBOW
              </h2>
              <span
                className="border px-1.5 py-0.5 text-[9px] tracking-[0.14em]"
                style={{ borderColor: withAlpha(current?.color ?? accent, 40) }}
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
            {assetOptions && onAssetChange && (
              <AssetToggle
                value={asset}
                options={assetOptions}
                onChange={onAssetChange}
              />
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
              style={{ borderColor: withAlpha(current.color, 20) }}
            >
              <RainbowStat label="CURRENT BAND" value={current.label} color={current.color} />
              <RainbowStat
                label="MODEL TREND"
                value={fmtValue(current.trend, rainbow.model.denomination)}
              />
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
                colors={current.colors}
                livePrice={price}
                isMobile={isMobile}
              />
            </div>
            <div className="relative mt-2 pt-3">
              <div className="grid h-2 grid-cols-9 overflow-hidden">
                {current.colors.map((color) => (
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
                <span>{current.labels[0]}</span>
                <span>{current.labels[4]}</span>
                <span>{current.labels[BAND_COUNT - 1]}</span>
              </div>
            </div>
            <ModelNote model={rainbow.model} source={rainbow.source} />
          </>
        ) : error ? (
          <div
            className="flex min-h-40 items-center justify-center text-center text-[11px]"
            style={{ opacity: 0.58 }}
          >
            {meta.label} rainbow history is temporarily unavailable.
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

/** A rainbow is only worth reading as far as its fit holds. R^2 is already in
 *  the stat row, but a number between 0 and 1 does not tell a reader when to
 *  stop trusting the bands, so say it in words below a weak one. */
function ModelNote({ model, source }: { model: RainbowModel; source: string }) {
  const weak = model.rSquared < 0.35
  return (
    <div
      className="mt-3 space-y-1 text-[9px] leading-relaxed tracking-[0.08em]"
      style={{ opacity: 0.5 }}
    >
      <div>
        {model.orientation === "inverted"
          ? "TREND DECAYS — BANDS READ AS DISTANCE FROM THAT DECAY, NOT AS VALUATION"
          : "TREND RISES — BANDS READ AS VALUATION AGAINST IT"}
        {" · FROM "}
        {model.sourceStart}
        {" · "}
        {source.toUpperCase()}
      </div>
      {weak && (
        <div style={{ color: E_STATIC.red, opacity: 0.85 }}>
          WEAK FIT: THE POWER LAW EXPLAINS ONLY{" "}
          {(model.rSquared * 100).toFixed(1)}% OF THIS SERIES. TREAT THE BANDS AS
          DECORATION, NOT SIGNAL.
        </div>
      )}
    </div>
  )
}

function AssetToggle({
  value,
  options,
  onChange,
}: {
  value: RainbowAsset
  options: readonly RainbowAsset[]
  onChange: (asset: RainbowAsset) => void
}) {
  return (
    <div
      className="inline-flex border"
      style={{ borderColor: withAlpha(paletteVar("ratio"), 33) }}
      aria-label="Rainbow asset"
    >
      {options.map((asset) => {
        const active = value === asset
        const color = paletteVar(ASSET_META[asset].token)
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
            {ASSET_META[asset].toggle}
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
  colors,
  livePrice,
  isMobile,
}: {
  asset: RainbowAsset
  data: RainbowPoint[]
  model: RainbowModel
  colors: string[]
  livePrice: number
  isMobile: boolean
}) {
  const width = isMobile ? 420 : 1000
  const height = isMobile ? 250 : 300
  const padding = {
    left: axisGutter(model.denomination, isMobile),
    right: 12,
    top: 10,
    bottom: 28,
  }
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
  const decades = Math.max(1, maxPower - minPower + 1)
  // A decade a tick suits Bitcoin's five-decade range, but ZEC/BTC covers
  // seven (labels would collide) and ZEC/USD barely two (two lonely
  // gridlines on a chart 300px tall). Thin out above six, and fall back to
  // 1-3-10 half-decades below four.
  const priceTicks: number[] = []
  if (decades < 4) {
    for (let power = minPower - 1; power <= maxPower; power += 1) {
      for (const mantissa of [1, 3]) {
        const tick = mantissa * 10 ** power
        if (Math.log10(tick) >= minLog && Math.log10(tick) <= maxLog) {
          priceTicks.push(tick)
        }
      }
    }
  } else {
    const step = Math.ceil(decades / 6)
    for (let power = minPower; power <= maxPower; power += step) {
      priceTicks.push(10 ** power)
    }
  }
  const dotColor = paletteVar(ASSET_META[asset].token)

  return (
    <svg
      role="img"
      aria-label={`${ASSET_META[asset].label} price and dynamic power-law rainbow bands`}
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
            {fmtTick(tick, model.denomination)}
          </text>
        </g>
      ))}
      {colors.map((color, index) => (
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
