"use client"

import { useMemo } from "react"
import type {
  IronwoodCohort,
  IronwoodDenominationBin,
  IronwoodMigrationTx,
} from "@/lib/ironwood-live"
import { paletteVar } from "@/components/theme"
import {
  WINDOW_MS,
  type IronwoodWindow,
  fmtCompact,
  fmtZec,
  formatTime,
} from "./utils"

const IRONWOOD = "#f6c945"
const ORCHARD = "#a78bfa"
const CYAN = "#67e8f9"
const RED = "#fb7185"

export function FlowTimeline({
  transactions,
  window,
  now,
}: {
  transactions: IronwoodMigrationTx[]
  window: IronwoodWindow
  now: number
}) {
  const chart = useMemo(() => {
    const timestamps = transactions
      .map((tx) => tx.timestamp)
      .filter((value): value is number => value != null)
    if (!timestamps.length) return null
    const earliest = Math.min(...timestamps) * 1000
    const latest = Math.max(...timestamps) * 1000
    const start =
      window === "ALL"
        ? Math.min(earliest, latest - 60_000)
        : now - WINDOW_MS[window]
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
  }, [now, transactions, window])

  if (!chart) return <ArmedEmpty label="FLOW CHART ARMED // WAITING FOR FIRST MIGRATION" />

  const barWidth = 25
  const gap = 4
  const chartHeight = 150
  const baseline = 170

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
      <div className="overflow-x-auto">
        <svg
          viewBox="0 0 720 215"
          className="block min-w-[620px] w-full"
          role="img"
          aria-label={`Migration volume and transaction count for ${window}`}
        >
          {[0, 0.5, 1].map((ratio) => {
            const y = baseline - chartHeight * ratio
            return (
              <line
                key={ratio}
                x1="24"
                x2="708"
                y1={y}
                y2={y}
                stroke={paletteVar("text")}
                strokeOpacity={ratio === 0 ? 0.22 : 0.1}
                strokeDasharray={ratio === 0 ? undefined : "2 5"}
              />
            )
          })}
          {chart.buckets.map((bucket, index) => {
            const x = 25 + index * (barWidth + gap)
            const barHeight = (bucket.volume / chart.maxVolume) * chartHeight
            const countY =
              baseline - (bucket.count / chart.maxCount) * chartHeight
            return (
              <g key={bucket.start}>
                <rect
                  x={x}
                  y={baseline - Math.max(1, barHeight)}
                  width={barWidth}
                  height={Math.max(1, barHeight)}
                  fill={IRONWOOD}
                  fillOpacity={bucket.volume > 0 ? 0.72 : 0.08}
                >
                  <title>
                    {`${fmtZec(bucket.volume)} ZEC // ${bucket.count} TX // ${formatTime(Math.round(bucket.start / 1000), { includeDate: true })}`}
                  </title>
                </rect>
                {index < chart.buckets.length - 1 && (
                  <line
                    x1={x + barWidth / 2}
                    x2={x + barWidth + gap + barWidth / 2}
                    y1={countY}
                    y2={
                      baseline -
                      (chart.buckets[index + 1].count / chart.maxCount) *
                        chartHeight
                    }
                    stroke={CYAN}
                    strokeWidth="1.5"
                    strokeOpacity="0.85"
                  />
                )}
                {bucket.count > 0 && (
                  <circle
                    cx={x + barWidth / 2}
                    cy={countY}
                    r="2.3"
                    fill={CYAN}
                  />
                )}
              </g>
            )
          })}
          <text x="24" y="198" fill={paletteVar("text")} opacity="0.5" fontSize="9">
            {formatTime(Math.round(chart.start / 1000), { includeDate: true })}
          </text>
          <text
            x="360"
            y="198"
            fill={paletteVar("text")}
            opacity="0.5"
            fontSize="9"
            textAnchor="middle"
          >
            {formatTime(Math.round((chart.start + chart.end) / 2 / 1000), {
              includeDate: true,
            })}
          </text>
          <text
            x="708"
            y="198"
            fill={paletteVar("text")}
            opacity="0.5"
            fontSize="9"
            textAnchor="end"
          >
            {formatTime(Math.round(chart.end / 1000), { includeDate: true })}
          </text>
        </svg>
      </div>
    </div>
  )
}

export function PrivacyScatter({
  transactions,
  onSelect,
}: {
  transactions: IronwoodMigrationTx[]
  onSelect: (tx: IronwoodMigrationTx) => void
}) {
  const points = useMemo(() => {
    const rows = transactions
      .filter((tx) => tx.timestamp != null && tx.amountZec > 0)
      .slice(0, 220)
    if (!rows.length) return null
    const minTime = Math.min(...rows.map((tx) => tx.timestamp ?? 0))
    const maxTime = Math.max(...rows.map((tx) => tx.timestamp ?? 0))
    const logs = rows.map((tx) => Math.log10(Math.max(tx.amountZec, 0.00000001)))
    const minLog = Math.min(...logs)
    const maxLog = Math.max(...logs)
    return {
      minTime,
      maxTime,
      minLog,
      maxLog,
      rows,
    }
  }, [transactions])

  if (!points) return <ArmedEmpty label="PRIVACY SCATTER ARMED // WAITING FOR FIRST MIGRATION" />

  const xFor = (timestamp: number) =>
    35 +
    ((timestamp - points.minTime) /
      Math.max(1, points.maxTime - points.minTime)) *
      650
  const yFor = (amount: number) =>
    175 -
    ((Math.log10(Math.max(amount, 0.00000001)) - points.minLog) /
      Math.max(0.0001, points.maxLog - points.minLog)) *
      145

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
      <div className="overflow-x-auto">
        <svg
          viewBox="0 0 720 215"
          className="block min-w-[620px] w-full"
          role="img"
          aria-label="Migration transaction amount over time, colored by privacy classification"
        >
          {[0, 0.5, 1].map((ratio) => (
            <line
              key={ratio}
              x1="35"
              x2="685"
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
          <text x="35" y="198" fill={paletteVar("text")} opacity="0.5" fontSize="9">
            {formatTime(points.minTime, { includeDate: true })}
          </text>
          <text
            x="685"
            y="198"
            fill={paletteVar("text")}
            opacity="0.5"
            fontSize="9"
            textAnchor="end"
          >
            {formatTime(points.maxTime, { includeDate: true })}
          </text>
          <text
            x="8"
            y="34"
            fill={paletteVar("text")}
            opacity="0.45"
            fontSize="8"
          >
            {fmtCompact(10 ** points.maxLog)}
          </text>
          <text
            x="8"
            y="175"
            fill={paletteVar("text")}
            opacity="0.45"
            fontSize="8"
          >
            {fmtCompact(10 ** points.minLog)}
          </text>
        </svg>
      </div>
    </div>
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
  const maxVolume = Math.max(...rows.map((row) => row.volumeZec), 1)
  const maxTx = Math.max(...rows.map((row) => row.txCount), 1)
  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-[560px] items-end gap-1 border-b pb-1" style={{ borderColor: `${ORCHARD}28` }}>
        {rows.map((cohort) => (
          <div
            key={cohort.boundary}
            className="group relative flex-1"
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
      <div className="mt-1 flex min-w-[560px] justify-between text-[8px]" style={{ opacity: 0.45 }}>
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
