"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { ArrowRight, ExternalLink } from "lucide-react"
import useSWR from "swr"
import { CornerBox, Skeleton } from "./primitives"
import { fmtCompactNumber, swrFetcher } from "./format"
import { paletteVar } from "./theme"

interface IronwoodMigration {
  totalMigratedZec: number
  txCount: number
  migratedPercent: number
  orchardZec: number
  ironwoodZec: number
  balanced: boolean | null
  firstHeight: number | null
  lastHeight: number | null
}

export interface IronwoodResponse {
  activationHeight: number
  currentHeight: number
  blocksRemaining: number
  activated: boolean
  avgBlockTimeSecs: number
  blockTimeSource: "cipherscan" | "protocol-target"
  estimatedActivationAt: number | null
  activationProgressPct: number
  phaseProgressPct: number
  migration: IronwoodMigration | null
  source: string
  fetchedAt: number
  stale?: boolean
}

const IRONWOOD_HREF = "/stats?view=ironwood#ironwood"
const ORCHARD = "#a78bfa"
const IRONWOOD = "#fbbf24"

function useIronwood() {
  return useSWR<IronwoodResponse>("/api/ironwood", swrFetcher, {
    refreshInterval: 60_000,
    dedupingInterval: 30_000,
    keepPreviousData: true,
    revalidateOnFocus: true,
  })
}

function formatDuration(milliseconds: number, compact = false): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  if (compact) {
    if (days > 0) return `${days}D ${hours}H`
    if (hours > 0) return `${hours}H ${minutes}M`
    return `${minutes}M`
  }
  return `${String(days).padStart(2, "0")}D ${String(hours).padStart(2, "0")}H ${String(minutes).padStart(2, "0")}M ${String(seconds).padStart(2, "0")}S`
}

function activationLabel(data: IronwoodResponse, compact = false): string {
  if (data.activated) {
    if (data.migration && data.migration.migratedPercent > 0) {
      return `${data.migration.migratedPercent.toFixed(1)}% MOVED`
    }
    return "LIVE"
  }
  if (data.estimatedActivationAt == null) return "TRACKING"
  return compact
    ? formatDuration(data.estimatedActivationAt - Date.now(), true)
    : formatDuration(data.estimatedActivationAt - Date.now())
}

function formatActivationTime(timestamp: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
    timeZoneName: "short",
  })
    .format(new Date(timestamp))
    .toUpperCase()
}

export function IronwoodChip() {
  const { data, error } = useIronwood()
  // Match dashboard TILE_CHIP box (h-5 / 9px / px-1) so this sits level
  // with the ZEC rank chip; countdown is the dense signal.
  return (
    <Link
      href={IRONWOOD_HREF}
      className="inline-flex h-5 max-w-full shrink-0 items-center gap-1 border px-1 text-[9px] font-bold leading-none tracking-[0.1em] transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
      style={{ color: IRONWOOD, borderColor: `${IRONWOOD}66`, outlineColor: IRONWOOD }}
      title="Open the Ironwood upgrade tracker"
    >
      <span className="shrink-0">IRONWOOD</span>
      <span
        className="min-w-0 truncate tabular-nums"
        style={{ color: paletteVar("text"), opacity: 0.8 }}
      >
        {data ? activationLabel(data, true) : error ? "OFFLINE" : "SYNC"}
      </span>
      <ArrowRight aria-hidden="true" size={10} strokeWidth={1.8} className="shrink-0" />
    </Link>
  )
}

export function IronwoodAtGlance({ onOpen }: { onOpen?: () => void }) {
  const { data, error } = useIronwood()

  return (
    <Link
      href={IRONWOOD_HREF}
      onClick={onOpen}
      className="group block min-w-[8.5rem] border px-2 py-1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
      style={{ borderColor: `${IRONWOOD}55`, outlineColor: IRONWOOD }}
      title="Open the Ironwood upgrade tracker"
    >
      <div className="flex items-center justify-between gap-2 text-[9px] tracking-[0.14em]">
        <span style={{ color: IRONWOOD }}>IRONWOOD</span>
        <ArrowRight
          aria-hidden="true"
          size={11}
          className="transition-transform group-hover:translate-x-0.5"
        />
      </div>
      {data ? (
        <>
          <div className="mt-0.5 whitespace-nowrap text-[11px] font-bold tabular-nums" style={{ color: IRONWOOD }}>
            {data.activated
              ? activationLabel(data, true)
              : `${fmtCompactNumber(data.blocksRemaining)} BLOCKS`}
          </div>
          <div className="mt-1 grid grid-cols-12 gap-px" aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => (
              <span
                key={index}
                className="h-1"
                style={{
                  background:
                    index < Math.round((data.phaseProgressPct / 100) * 12)
                      ? IRONWOOD
                      : paletteVar("text"),
                  opacity:
                    index < Math.round((data.phaseProgressPct / 100) * 12)
                      ? 0.9
                      : 0.12,
                }}
              />
            ))}
          </div>
        </>
      ) : error ? (
        <div className="mt-1 text-[9px]" style={{ opacity: 0.55 }}>TEMPORARILY OFFLINE</div>
      ) : (
        <Skeleton className="mt-1" height={14} />
      )}
    </Link>
  )
}

export function IronwoodStatusPill() {
  const { data, error } = useIronwood()
  const progress = data?.phaseProgressPct ?? 0
  // Compact single-line chip for the dashboard ZEC panel — label,
  // micro progress strip, and countdown share one h-5 row.
  const filled = Math.round((progress / 100) * 6)

  return (
    <Link
      href={IRONWOOD_HREF}
      className="group block only:col-span-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
      style={{ outlineColor: IRONWOOD }}
      title="Open Ironwood details in ZEC stats"
    >
      <div
        className="flex h-5 items-center gap-1.5 border px-1.5 text-[9px] font-bold leading-none tracking-[0.12em]"
        style={{
          borderColor: `${IRONWOOD}55`,
          background: `${IRONWOOD}08`,
          color: IRONWOOD,
        }}
      >
        <span className="shrink-0">IRONWOOD</span>
        <span className="inline-flex min-w-0 flex-1 items-center gap-px" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <span
              key={index}
              className="h-1 min-w-[3px] flex-1"
              style={{
                background: index < filled ? IRONWOOD : paletteVar("text"),
                opacity: index < filled ? 0.9 : 0.12,
              }}
            />
          ))}
        </span>
        <span className="shrink-0 whitespace-nowrap tabular-nums">
          {data ? activationLabel(data, true) : error ? "OFFLINE" : "SYNC"}
        </span>
        <ArrowRight
          aria-hidden="true"
          size={10}
          strokeWidth={1.8}
          className="shrink-0 transition-transform group-hover:translate-x-0.5"
        />
      </div>
    </Link>
  )
}

export function IronwoodPanel({ id }: { id?: string }) {
  const { data, error } = useIronwood()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!data?.estimatedActivationAt || data.activated) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [data?.activated, data?.estimatedActivationAt])

  const remainingMs = data?.estimatedActivationAt
    ? Math.max(0, data.estimatedActivationAt - now)
    : 0

  return (
    <div id={id} className="scroll-mt-4 space-y-3">
      <CornerBox color={IRONWOOD}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[12px] font-bold tracking-[0.2em]">IRONWOOD UPGRADE</h2>
              <span
                className="border px-1.5 py-0.5 text-[9px] font-bold tracking-[0.14em]"
                style={{ color: data?.activated ? paletteVar("cyph") : IRONWOOD, borderColor: `${data?.activated ? paletteVar("cyph") : IRONWOOD}66` }}
              >
                {data?.activated ? "ACTIVE" : "COUNTDOWN"}
              </span>
              {data?.stale && (
                <span className="text-[9px] tracking-[0.14em]" style={{ opacity: 0.55 }}>CACHE</span>
              )}
            </div>
          </div>
          <a
            href="https://cipherscan.app/migration"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[10px] font-bold tracking-[0.14em] underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-1"
            style={{ color: IRONWOOD, outlineColor: IRONWOOD }}
          >
            CIPHERSCAN <ExternalLink aria-hidden="true" size={11} />
          </a>
        </div>

        {data ? (
          <>
            <div className="mt-4 grid gap-4 border-y py-4 md:grid-cols-[1.1fr_0.9fr]" style={{ borderColor: `${IRONWOOD}33` }}>
              <div>
                <div className="text-[9px] tracking-[0.18em]" style={{ opacity: 0.58 }}>
                  {data.activated ? "MIGRATION STATUS" : "ESTIMATED ACTIVATION IN"}
                </div>
                <div
                  className="mt-1 whitespace-nowrap text-[clamp(1.55rem,5vw,2.5rem)] font-bold leading-none tabular-nums"
                  style={{ color: IRONWOOD, textShadow: `0 0 10px ${IRONWOOD}44` }}
                >
                  {data.activated ? activationLabel(data) : formatDuration(remainingMs)}
                </div>
                <div className="mt-2 text-[10px] tabular-nums" style={{ opacity: 0.62 }}>
                  {data.activated
                    ? `ACTIVATED AT BLOCK ${data.activationHeight.toLocaleString()}`
                    : `${data.blocksRemaining.toLocaleString()} BLOCKS REMAINING`}
                </div>
              </div>
              <div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <TrackerStat label="CHAIN TIP" value={data.currentHeight.toLocaleString()} />
                  <TrackerStat label="TARGET" value={data.activationHeight.toLocaleString()} color={IRONWOOD} />
                  <TrackerStat
                    label={data.blockTimeSource === "cipherscan" ? "OBSERVED BLOCK" : "TARGET BLOCK"}
                    value={`${data.avgBlockTimeSecs.toFixed(data.avgBlockTimeSecs % 1 ? 1 : 0)} SEC`}
                  />
                  <TrackerStat
                    label="HEIGHT PROGRESS"
                    value={`${data.activationProgressPct.toFixed(2)}%`}
                  />
                </div>
                <div
                  className="mt-3 grid gap-px border p-px"
                  style={{ borderColor: `${IRONWOOD}33`, background: `${IRONWOOD}22` }}
                >
                  <TrackerStat
                    label="EST. ACTIVATION"
                    value={
                      data.estimatedActivationAt
                        ? formatActivationTime(data.estimatedActivationAt)
                        : "ACTIVE"
                    }
                    color={IRONWOOD}
                    framed
                  />
                </div>
              </div>
            </div>

            <UpgradeRail progress={data.phaseProgressPct} activated={data.activated} />

            {data.activated && data.migration && (
              <MigrationDetails migration={data.migration} />
            )}

            <div className="mt-3 flex flex-wrap justify-between gap-2 text-[9px] tracking-[0.12em]" style={{ opacity: 0.52 }}>
              <span>ESTIMATE = BLOCKS REMAINING x OBSERVED BLOCK INTERVAL</span>
              <span>UPDATED {new Date(data.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
            </div>
          </>
        ) : error ? (
          <div className="flex min-h-52 items-center justify-center text-center text-[11px]" style={{ opacity: 0.58 }}>
            Ironwood progress is temporarily unavailable.
          </div>
        ) : (
          <div className="mt-4"><Skeleton height={260} /></div>
        )}
      </CornerBox>
    </div>
  )
}

function UpgradeRail({ progress, activated }: { progress: number; activated: boolean }) {
  const segments = 36
  const activeSegments = Math.round((progress / 100) * segments)
  return (
    <div className="mt-4">
      <div className="flex items-end justify-between gap-3 text-[9px] font-bold tracking-[0.16em]">
        <span style={{ color: ORCHARD }}>NU6.2 / ORCHARD</span>
        <span className="tabular-nums" style={{ color: IRONWOOD }}>
          {activated ? "GATE OPEN" : `${progress.toFixed(2)}% TO GATE`}
        </span>
        <span style={{ color: IRONWOOD }}>IRONWOOD</span>
      </div>
      <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="grid grid-cols-[repeat(18,minmax(0,1fr))] gap-px">
          {Array.from({ length: segments / 2 }, (_, index) => (
            <span
              key={index}
              className="h-3"
              style={{
                background: index < Math.min(activeSegments, segments / 2) ? ORCHARD : paletteVar("text"),
                opacity: index < Math.min(activeSegments, segments / 2) ? 0.8 : 0.1,
              }}
            />
          ))}
        </div>
        <div
          className="grid size-8 place-items-center border text-[13px] font-bold"
          style={{ color: activated ? paletteVar("cyph") : IRONWOOD, borderColor: `${IRONWOOD}88` }}
          title="Network upgrade activation gate"
        >
          {activated ? "OK" : "#"}
        </div>
        <div className="grid grid-cols-[repeat(18,minmax(0,1fr))] gap-px">
          {Array.from({ length: segments / 2 }, (_, index) => {
            const on = activeSegments > segments / 2 + index
            return (
              <span
                key={index}
                className="h-3"
                style={{ background: on ? IRONWOOD : paletteVar("text"), opacity: on ? 0.9 : 0.1 }}
              />
            )
          })}
        </div>
      </div>
      <div className="mt-1 flex justify-between text-[9px] tabular-nums" style={{ opacity: 0.48 }}>
        <span>BLOCK 3,364,600</span>
        <span>BLOCK 3,428,143</span>
      </div>
    </div>
  )
}

function MigrationDetails({ migration }: { migration: IronwoodMigration }) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-px border md:grid-cols-4" style={{ borderColor: `${IRONWOOD}33` }}>
      <TrackerStat label="MIGRATED" value={`${fmtCompactNumber(migration.totalMigratedZec)} ZEC`} color={IRONWOOD} framed />
      <TrackerStat label="MIGRATION TX" value={migration.txCount.toLocaleString()} framed />
      <TrackerStat label="ORCHARD POOL" value={`${fmtCompactNumber(migration.orchardZec)} ZEC`} color={ORCHARD} framed />
      <TrackerStat
        label="SUPPLY AUDIT"
        value={migration.balanced == null ? "PENDING" : migration.balanced ? "BALANCED" : "CHECK"}
        color={migration.balanced ? paletteVar("cyph") : IRONWOOD}
        framed
      />
    </div>
  )
}

function TrackerStat({
  label,
  value,
  color,
  framed = false,
}: {
  label: string
  value: string
  color?: string
  framed?: boolean
}) {
  return (
    <div className={framed ? "min-w-0 px-2 py-2" : "min-w-0"}>
      <div className="text-[9px] tracking-[0.14em]" style={{ opacity: 0.52 }}>{label}</div>
      <div className="mt-0.5 truncate text-[11px] font-bold tabular-nums" title={value} style={{ color: color ?? paletteVar("text") }}>
        {value}
      </div>
    </div>
  )
}
