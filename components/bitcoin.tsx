"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { CornerBox, InfoTip, PhosphorSpark, Skeleton, useIsMobile } from "./primitives"
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

// BTC price sparkline windows. `days` maps straight onto /api/prices?days=.
// "1" is the intraday path; "270" (~9M) is registered server-side too.
type SparkPeriod = "1" | "7" | "30" | "90" | "270"
const SPARK_PERIODS: { value: SparkPeriod; label: string }[] = [
  { value: "1", label: "1D" },
  { value: "7", label: "1W" },
  { value: "30", label: "1M" },
  { value: "90", label: "3M" },
  { value: "270", label: "9M" },
]

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

      <BtcSparkline isMobile={isMobile} />

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

function BtcSparkline({ isMobile }: { isMobile: boolean }) {
  const [period, setPeriod] = useState<SparkPeriod>("90")
  const { data, error } = useSWR<PricesResponse>(
    `/api/prices?days=${period}`,
    swrFetcher,
    { refreshInterval: 60_000, keepPreviousData: true }
  )
  const points = useMemo(() => {
    const rows = (data?.history ?? []).flatMap((point) =>
      point.btc != null && Number.isFinite(point.btc) && point.btc > 0
        ? [point.btc]
        : []
    )
    // Keep the live BTC spot as the trailing point so 1D tracks the ticker.
    const live = data?.current?.btc?.price
    if (live != null && Number.isFinite(live) && live > 0) {
      if (rows.length === 0 || rows[rows.length - 1] !== live) rows.push(live)
    }
    return rows
  }, [data])

  const last = points[points.length - 1] ?? null
  const first = points[0] ?? null
  const change =
    first != null && last != null && first > 0
      ? ((last - first) / first) * 100
      : null
  const changeColor = valueColor(change)
  const ratio = paletteVar("ratio")

  return (
    <CornerBox color={ratio}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[12px] font-bold tracking-[0.2em]">BTC PRICE</h2>
          {last != null && (
            <span
              className="text-[13px] font-bold tabular-nums"
              style={{ color: ratio }}
            >
              {fmtUSD(last, { maxFrac: 0, minFrac: 0 })}
            </span>
          )}
          {change != null && (
            <span className="text-[11px] font-bold tabular-nums" style={{ color: changeColor }}>
              {signedPct(change)}
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
          <PhosphorSpark
            values={points}
            color={ratio}
            height={isMobile ? 56 : 72}
            strokeWidth={1.6}
          />
        ) : error ? (
          <DataMessage text="BTC price history is temporarily unavailable." />
        ) : (
          <Skeleton height={isMobile ? 56 : 72} />
        )}
      </div>
    </CornerBox>
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
