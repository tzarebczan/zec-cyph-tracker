"use client"

import { useMemo } from "react"
import type {
  IronwoodCohort,
  IronwoodDenominationBin,
  IronwoodMigrationTx,
} from "@/lib/ironwood-live"
import { IRONWOOD_ACTIVATION_TIME } from "@/lib/ironwood-live"
import { paletteVar } from "@/components/theme"
import {
  WINDOW_MS,
  type IronwoodWindow,
  fmtCompact,
  fmtZec,
  formatTick,
} from "./utils"

const DAY_MS = 24 * 60 * 60_000

const IRONWOOD = "#f6c945"
const ORCHARD = "#a78bfa"
const CYAN = "#67e8f9"
const RED = "#fb7185"

interface FlowTimelineBucket {
  start: number
  end: number
  volume: number
  count: number
}

interface FlowTimelineModel {
  buckets: FlowTimelineBucket[]
  start: number
  end: number
  maxVolume: number
  maxCount: number
}

export function FlowTimeline({
  transactions,
  range,
  now,
}: {
  transactions: IronwoodMigrationTx[]
  range: IronwoodWindow
  now: number
}) {
  const chart = useMemo<FlowTimelineModel | null>(() => {
    const timestamps = transactions
      .map((tx) => tx.timestamp)
      .filter((value): value is number => value != null)
    if (!timestamps.length) return null
    const earliest = Math.min(...timestamps) * 1000
    const latest = Math.max(...timestamps) * 1000
    const start =
      range === "ALL"
        ? Math.min(earliest, latest - 60_000)
        : now - WINDOW_MS[range]
    const end = Math.max(now, latest + 1_000)
    const bucketCount = 24
    const span = Math.max(1, end - start)
    const buckets = Array.from({ length: bucketCount }, (_, index) => ({
      start: start + (index / bucketCount) * span,
      end: start + ((index + 1) / bucketCount) * span,
      volume: 0,
      count: 0,
    }))
    for (const tx of transactions) {
      if (tx.timestamp == null) continue
      const ms = tx.timestamp * 1000
      if (ms < start || ms > end) continue
      const index = Math.min(
        bucketCount - 1,
        Math.max(0, Math.floor(((ms - start) / span) * bucketCount))
      )
      buckets[index].volume += tx.amountZec
      buckets[index].count += 1
    }
    return {
      buckets,
      start,
      end,
      maxVolume: Math.max(...buckets.map((bucket) => bucket.volume), 1),
      maxCount: Math.max(...buckets.map((bucket) => bucket.count), 1),
    }
  }, [now, transactions, range])

  if (!chart) return <ArmedEmpty label="FLOW CHART ARMED // WAITING FOR FIRST MIGRATION" />

  // Multi-day ranges need the date on the axis; anything shorter reads
  // cleaner as bare clock times.
  const spanDays = chart.end - chart.start >= DAY_MS
  const tick = (ms: number) =>
    formatTick(Math.round(ms / 1000), { includeDate: spanDays })

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[9px] tracking-[0.13em]">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-4" style={{ background: IRONWOOD }} />
          ZEC MIGRATED
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-px w-4" style={{ background: CYAN }} />
          TX COUNT
        </span>
      </div>
      {/* Two geometries rather than one wide viewBox scaled down, matching
          PrivacyScatterPlot below. A 720-wide viewBox in a ~330px phone
          column renders at 0.45x, which put the 9px axis labels at ~4px. */}
      <div className="sm:hidden">
        <FlowTimelinePlot chart={chart} range={range} tick={tick} compact />
      </div>
      <div className="hidden sm:block">
        <FlowTimelinePlot chart={chart} range={range} tick={tick} />
      </div>
    </div>
  )
}

function FlowTimelinePlot({
  chart,
  range,
  tick,
  compact = false,
}: {
  chart: FlowTimelineModel
  range: IronwoodWindow
  tick: (ms: number) => string
  compact?: boolean
}) {
  const width = compact ? 360 : 720
  const left = 24
  const right = width - 12
  const barWidth = compact ? 10 : 25
  const gap = compact ? 3 : 4
  const chartHeight = 150
  const baseline = 170
  const barX = (index: number) => left + 1 + index * (barWidth + gap)
  const centerX = (index: number) => barX(index) + barWidth / 2
  const countY = (count: number) =>
    baseline - (count / chart.maxCount) * chartHeight

  return (
    <svg
      viewBox={`0 0 ${width} 215`}
      className="block w-full"
      role="img"
      aria-label={`Migration volume and transaction count for ${range}`}
    >
      {[0, 0.5, 1].map((ratio) => {
        const y = baseline - chartHeight * ratio
        return (
          <line
            key={ratio}
            x1={left}
            x2={right}
            y1={y}
            y2={y}
            stroke={paletteVar("text")}
            strokeOpacity={ratio === 0 ? 0.22 : 0.1}
            strokeDasharray={ratio === 0 ? undefined : "2 5"}
          />
        )
      })}
      {chart.buckets.map((bucket, index) => {
        const barHeight = (bucket.volume / chart.maxVolume) * chartHeight
        return (
          <rect
            key={bucket.start}
            x={barX(index)}
            y={baseline - Math.max(1, barHeight)}
            width={barWidth}
            height={Math.max(1, barHeight)}
            fill={IRONWOOD}
            fillOpacity={bucket.volume > 0 ? 0.72 : 0.08}
          >
            <title>
              {`${fmtZec(bucket.volume)} ZEC // ${bucket.count} TX // ${tick(bucket.start)}`}
            </title>
          </rect>
        )
      })}
      {/* Tx-count overlay as one polyline rather than per-bucket segments —
          the joins render continuously and it's a single node instead of 23. */}
      <polyline
        fill="none"
        stroke={CYAN}
        strokeWidth="1.5"
        strokeOpacity="0.85"
        points={chart.buckets
          .map((bucket, index) => `${centerX(index)},${countY(bucket.count)}`)
          .join(" ")}
      />
      {chart.buckets.map((bucket, index) =>
        bucket.count > 0 ? (
          <circle
            key={bucket.start}
            cx={centerX(index)}
            cy={countY(bucket.count)}
            r={compact ? 1.8 : 2.3}
            fill={CYAN}
          />
        ) : null
      )}
      <text x={left} y="198" fill={paletteVar("text")} opacity="0.5" fontSize="9">
        {tick(chart.start)}
      </text>
      <text
        x={width / 2}
        y="198"
        fill={paletteVar("text")}
        opacity="0.5"
        fontSize="9"
        textAnchor="middle"
      >
        {tick((chart.start + chart.end) / 2)}
      </text>
      <text
        x={right}
        y="198"
        fill={paletteVar("text")}
        opacity="0.5"
        fontSize="9"
        textAnchor="end"
      >
        {tick(chart.end)}
      </text>
    </svg>
  )
}

interface PrivacyScatterModel {
  minTime: number
  maxTime: number
  minLog: number
  maxLog: number
  rows: IronwoodMigrationTx[]
  spansDays: boolean
}

export function PrivacyScatter({
  transactions,
  range,
  now,
  onSelect,
}: {
  transactions: IronwoodMigrationTx[]
  range: IronwoodWindow
  now: number
  onSelect: (tx: IronwoodMigrationTx) => void
}) {
  const points = useMemo<PrivacyScatterModel | null>(() => {
    const eligible = transactions
      .filter((tx) => {
        if (tx.timestamp == null || tx.amountZec <= 0) return false
        if (range === "ALL") return true
        return tx.timestamp * 1000 >= now - WINDOW_MS[range]
      })
      .sort(
        (a, b) =>
          (a.timestamp ?? 0) - (b.timestamp ?? 0) ||
          a.height - b.height
      )
    const sampleSize = Math.min(220, eligible.length)
    const rows =
      eligible.length <= sampleSize
        ? eligible
        : Array.from({ length: sampleSize }, (_, index) => {
            const sourceIndex = Math.round(
              (index / Math.max(1, sampleSize - 1)) *
                (eligible.length - 1)
            )
            return eligible[sourceIndex]
          })
    if (!rows.length) return null
    // Quantizing the right edge prevents a fresh analytics response from
    // visibly rescaling the entire chart every few seconds. ALL always begins
    // at activation; fixed windows retain their full selected duration.
    const axisStepSeconds = 15 * 60
    const maxTime =
      Math.ceil(now / 1000 / axisStepSeconds) * axisStepSeconds
    const activationTime =
      Math.floor(new Date(IRONWOOD_ACTIVATION_TIME).getTime() / 1000)
    const minTime =
      range === "ALL"
        ? activationTime
        : maxTime - WINDOW_MS[range] / 1000
    const logs = rows.map((tx) => Math.log10(Math.max(tx.amountZec, 0.00000001)))
    const minLog = Math.min(...logs)
    const maxLog = Math.max(...logs)
    return {
      minTime,
      maxTime,
      minLog,
      maxLog,
      rows,
      spansDays:
        range === "ALL" || WINDOW_MS[range] >= DAY_MS,
    }
  }, [now, range, transactions])

  if (!points) {
    return (
      <ArmedEmpty
        label={
          range === "ALL"
            ? "PRIVACY SCATTER ARMED // WAITING FOR FIRST MIGRATION"
            : `NO MIGRATIONS IN THE SELECTED ${range === "24H" ? "1D" : "1W"} WINDOW`
        }
      />
    )
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[9px] tracking-[0.13em]">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2 rounded-full"
            style={{ background: IRONWOOD }}
          />
          DENOMINATED
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2 rounded-full"
            style={{ background: RED }}
          />
          DISTINCTIVE
        </span>
        <span style={{ opacity: 0.48 }}>LOG SCALE // TAP A POINT</span>
      </div>
      <div className="sm:hidden">
        <PrivacyScatterPlot points={points} onSelect={onSelect} compact />
      </div>
      <div className="hidden sm:block">
        <PrivacyScatterPlot points={points} onSelect={onSelect} />
      </div>
    </div>
  )
}

function PrivacyScatterPlot({
  points,
  onSelect,
  compact = false,
}: {
  points: PrivacyScatterModel
  onSelect: (tx: IronwoodMigrationTx) => void
  compact?: boolean
}) {
  const width = compact ? 360 : 720
  const left = compact ? 32 : 35
  const right = compact ? 344 : 685
  const xFor = (timestamp: number) =>
    left +
    ((timestamp - points.minTime) /
      Math.max(1, points.maxTime - points.minTime)) *
      (right - left)
  const yFor = (amount: number) =>
    175 -
    ((Math.log10(Math.max(amount, 0.00000001)) - points.minLog) /
      Math.max(0.0001, points.maxLog - points.minLog)) *
      145

  return (
    <svg
      viewBox={`0 0 ${width} 215`}
      className="block w-full"
      role="img"
      aria-label="Migration transaction amount over time, colored by privacy classification"
    >
      {[0, 0.5, 1].map((ratio) => (
        <line
          key={ratio}
          x1={left}
          x2={right}
          y1={175 - ratio * 145}
          y2={175 - ratio * 145}
          stroke={paletteVar("text")}
          strokeOpacity="0.1"
          strokeDasharray="2 5"
        />
      ))}
      {points.rows.map((tx) => (
        <circle
          key={tx.txid}
          cx={xFor(tx.timestamp ?? points.minTime)}
          cy={yFor(tx.amountZec)}
          r={Math.max(3, Math.min(7, 3 + Math.log10(tx.amountZec + 1)))}
          fill={tx.privacy === "denominated" ? IRONWOOD : RED}
          fillOpacity="0.78"
          stroke="#070a0c"
          strokeWidth="1"
          className="cursor-pointer transition-opacity hover:opacity-100"
          onClick={() => onSelect(tx)}
          tabIndex={0}
          role="button"
          aria-label={`${fmtZec(tx.amountZec)} ZEC migration at block ${tx.height}`}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") onSelect(tx)
          }}
        >
          <title>
            {`${fmtZec(tx.amountZec)} ZEC // #${tx.height} // ${tx.privacy}`}
          </title>
        </circle>
      ))}
      <text x={left} y="198" fill={paletteVar("text")} opacity="0.5" fontSize="9">
        {formatTick(points.minTime, { includeDate: points.spansDays })}
      </text>
      <text
        x={right}
        y="198"
        fill={paletteVar("text")}
        opacity="0.5"
        fontSize="9"
        textAnchor="end"
      >
        {formatTick(points.maxTime, { includeDate: points.spansDays })}
      </text>
      <text
        x="5"
        y="34"
        fill={paletteVar("text")}
        opacity="0.45"
        fontSize="8"
      >
        {fmtCompact(10 ** points.maxLog)}
      </text>
      <text
        x="5"
        y="175"
        fill={paletteVar("text")}
        opacity="0.45"
        fontSize="8"
      >
        {fmtCompact(10 ** points.minLog)}
      </text>
    </svg>
  )
}

export function DenominationBars({
  bins,
}: {
  bins: IronwoodDenominationBin[]
}) {
  if (!bins.length) return <ArmedEmpty label="DENOMINATION DATA STARTS AFTER ACTIVATION" />
  const max = Math.max(...bins.map((bin) => bin.txCount), 1)
  return (
    <div className="space-y-2">
      {bins.map((bin) => (
        <div
          key={`${bin.power}-${bin.label}`}
          className="grid grid-cols-[5.5rem_minmax(0,1fr)_4rem] items-center gap-2 text-[10px]"
        >
          <span className="truncate" title={bin.label}>
            {bin.label}
          </span>
          <div className="h-3" style={{ background: `${IRONWOOD}10` }}>
            <div
              className="h-full transition-[width]"
              style={{
                width: `${Math.max(1, (bin.txCount / max) * 100)}%`,
                background: IRONWOOD,
                opacity: 0.78,
              }}
            />
          </div>
          <span className="text-right font-bold tabular-nums" style={{ color: IRONWOOD }}>
            {bin.txCount.toLocaleString("en-US")}
          </span>
        </div>
      ))}
    </div>
  )
}

export function CohortTimeline({ cohorts }: { cohorts: IronwoodCohort[] }) {
  if (!cohorts.length) return <ArmedEmpty label="COHORTS FORM AFTER THE FIRST MIGRATION BOUNDARY" />
  const rows = cohorts.slice(-24)
  const emptySlots = Math.max(0, 24 - rows.length)
  const maxVolume = Math.max(...rows.map((row) => row.volumeZec), 1)
  const maxTx = Math.max(...rows.map((row) => row.txCount), 1)
  return (
    <div>
      <div
        className="grid h-[106px] w-full grid-cols-[repeat(24,minmax(0,1fr))] items-end gap-px border-b pb-1 sm:gap-1"
        style={{ borderColor: `${ORCHARD}28` }}
      >
        {Array.from({ length: emptySlots }, (_, index) => (
          <span key={`empty-${index}`} aria-hidden="true" />
        ))}
        {rows.map((cohort) => (
          <div
            key={cohort.boundary}
            className="group relative min-w-0"
            title={`#${cohort.boundaryStartHeight.toLocaleString()} // ${fmtZec(cohort.volumeZec)} ZEC // ${cohort.txCount} TX`}
          >
            <div
              className="mx-auto w-full"
              style={{
                height: `${Math.max(4, (cohort.volumeZec / maxVolume) * 100)}px`,
                background: ORCHARD,
                opacity: 0.68,
              }}
            />
            <div
              className="mx-auto mt-px h-1"
              style={{
                width: `${Math.max(10, (cohort.txCount / maxTx) * 100)}%`,
                background: CYAN,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex w-full justify-between text-[8px]" style={{ opacity: 0.45 }}>
        <span>OLDER COHORTS</span>
        <span>LATEST BOUNDARY</span>
      </div>
    </div>
  )
}

function ArmedEmpty({ label }: { label: string }) {
  return (
    <div
      className="grid min-h-44 place-items-center border text-center text-[10px] tracking-[0.14em]"
      style={{
        borderColor: `${paletteVar("text")}20`,
        color: paletteVar("text"),
        opacity: 0.46,
      }}
    >
      {label}
    </div>
  )
}
