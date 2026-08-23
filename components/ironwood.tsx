"use client"

import Link from "next/link"
import { ArrowRight, Radio } from "lucide-react"
import useSWR from "swr"
import { CornerBox, Skeleton } from "./primitives"
import { fmtCompactNumber, swrFetcher } from "./format"
import { paletteVar } from "./theme"

interface IronwoodMigration {
  totalMigratedZec: number
  txCount: number
  migratedPercent: number
  /** Orchard-sourced share — see the route's doc comment. Optional so a stale
   *  pre-v4 payload degrades instead of rendering NaN. */
  orchardMigratedPct?: number
  fromOrchardZec?: number
  velocityZecPerHour?: number
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
  approachProgressPct: number
  migration: IronwoodMigration | null
  source: string
  fetchedAt: number
  stale?: boolean
}

/** The full live tracker. Both the dashboard banner and the stats-page
 *  chip deep-link here. */
const IRONWOOD_HREF = "/ironwood"
const ORCHARD = "#a78bfa"
const IRONWOOD = "#fbbf24"
// Matches the tracker page's accent for live/rate figures.
const CYAN = "#67e8f9"

/** Poll cadence by distance to the gate. Blocks land ~75s apart, so a flat 60s
 *  poll let two or three heights go by between paints; 1 block out we're on a
 *  5s beat. Post-activation the totals move continuously, so this holds at 30s
 *  instead of relaxing back to a minute.
 *
 *  Declared at module scope deliberately. SWR keys its polling effect on the
 *  `refreshInterval` reference, so an inline arrow — a new identity on every
 *  render — makes that effect tear down and reschedule the timer each render. A
 *  component re-rendering faster than its own interval then never polls at all,
 *  which is what left these feeds looking frozen in the background. */
function ironwoodRefreshInterval(latest: IronwoodResponse | undefined): number {
  if (latest == null || latest.activated) return 30_000
  const blocks = latest.blocksRemaining
  if (!Number.isFinite(blocks)) return 60_000
  if (blocks <= 1) return 5_000
  if (blocks <= 10) return 8_000
  if (blocks <= 50) return 15_000
  if (blocks <= 300) return 30_000
  return 60_000
}

function useIronwood() {
  return useSWR<IronwoodResponse>("/api/ironwood", swrFetcher, {
    refreshInterval: ironwoodRefreshInterval,
    // Keep polling in a background tab instead of freezing until refocus.
    refreshWhenHidden: true,
    // Must stay under the fastest interval above or SWR drops those polls.
    dedupingInterval: 3_000,
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

/** Orchard holds ~3.66M ZEC, so the migrated share sits below 0.01% for a
 *  long stretch after the gate opens. A hard `toFixed(2)` renders that as a
 *  giant "0.00%", which reads as broken rather than "barely started" — so
 *  anything non-zero under the rounding floor gets an explicit `<`. */
function formatMovedPct(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return "0.00%"
  if (pct < 0.01) return "<0.01%"
  return `${pct.toFixed(2)}%`
}

/** Mean ZEC/hour since the first migration, not an instantaneous rate — kept
 *  short enough for a 4-up stat cell. Labelled AVG so the falling number as the
 *  average smooths doesn't read as the migration slowing down. */
function formatVelocity(zecPerHour: number): string {
  if (!Number.isFinite(zecPerHour) || zecPerHour <= 0) return "--"
  if (zecPerHour < 1) return `${zecPerHour.toFixed(2)}/H`
  return `${fmtCompactNumber(zecPerHour)}/H`
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

/* ── Dashboard banner ────────────────────────────────────────────────
   Full-width strip above the price tiles rather than a fourth grid column,
   so it can carry four stats and a pool bar without shrinking the
   CYPH/ZEC/RATIO readouts that are the page's primary content.

   The pre-activation countdown that used to live here is gone: NU6.3
   activated at block 3,428,143 and that's a one-way transition, so the
   countdown branch became permanently unreachable. */
export function IronwoodBanner() {
  const { data, error } = useIronwood()

  if (error && !data) return null

  return (
    <Link
      href={IRONWOOD_HREF}
      className="group mb-2 md:mb-3 block focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
      style={{ outlineColor: IRONWOOD }}
      title="Open the live Ironwood tracker"
    >
      <CornerBox
        color={IRONWOOD}
        interactive
        style={{
          background: `linear-gradient(100deg, ${ORCHARD}0b, transparent 45%, ${IRONWOOD}0d)`,
        }}
      >
        <div className="flex items-center gap-2">
          <span
            className="text-[11px] font-bold tracking-[0.22em]"
            style={{ color: IRONWOOD, textShadow: `0 0 6px ${IRONWOOD}55` }}
          >
            IRONWOOD
          </span>
          <span
            className="box-border inline-flex h-[18px] items-center gap-1 border px-1.5 text-[9px] font-bold leading-none tracking-[0.1em]"
            style={{ borderColor: `${IRONWOOD}55`, color: IRONWOOD }}
          >
            <Radio aria-hidden="true" size={9} className="cz-led-pulse" />
            MIGRATING
          </span>
          {data?.stale && (
            <span
              className="text-[9px] tracking-[0.12em]"
              style={{ opacity: 0.5 }}
            >
              CACHE
            </span>
          )}
          <span
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-[9px] font-bold tracking-[0.12em]"
            style={{ color: IRONWOOD }}
          >
            <span className="hidden sm:inline">TRACK LIVE</span>
            <ArrowRight
              aria-hidden="true"
              size={11}
              strokeWidth={1.8}
              className="transition-transform group-hover:translate-x-0.5"
            />
          </span>
        </div>

        {!data ? (
          <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Skeleton height={54} />
            <Skeleton height={54} />
          </div>
        ) : (
          <MigrationSummary data={data} />
        )}
      </CornerBox>
    </Link>
  )
}

function MigrationSummary({ data }: { data: IronwoodResponse }) {
  const migration = data.migration
  const orchard = migration?.orchardZec ?? 0
  const ironwood = migration?.ironwoodZec ?? 0
  // Orchard-sourced progress, not the whole Ironwood pool. Ironwood also takes
  // Sapling / transparent inflow that was never in Orchard, so pool-based
  // shares overstate the migration — that's why upstream's migratedPercent
  // (5.07%) ran ahead of cipherscan's headline ORCHARD → IRONWOOD (4.30%).
  // Falls back to the pool share only for stale pre-v4 payloads.
  const base = orchard + ironwood
  const movedPct =
    migration?.orchardMigratedPct ??
    migration?.migratedPercent ??
    (base > 0 ? (ironwood / base) * 100 : 0)

  return (
    <div className="mt-2 grid gap-2 md:grid-cols-[auto_minmax(0,1fr)] md:items-end md:gap-4">
      <div>
        <div
          className="text-[clamp(1.6rem,7vw,2.5rem)] font-bold leading-none tabular-nums"
          style={{ color: IRONWOOD, textShadow: `0 0 10px ${IRONWOOD}44` }}
        >
          {formatMovedPct(movedPct)}
        </div>
        <div
          className="mt-0.5 text-[8px] tracking-[0.16em]"
          style={{ opacity: 0.5 }}
        >
          OF ORCHARD MIGRATED
        </div>
      </div>

      <div className="min-w-0">
        {/* 2x2 on phones — four values at 11px bold don't fit one 320px row. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <BannerStat
            label="IRONWOOD POOL"
            value={`${fmtCompactNumber(ironwood)} ZEC`}
            color={IRONWOOD}
          />
          <BannerStat
            label="MIGRATION TX"
            value={(migration?.txCount ?? 0).toLocaleString("en-US")}
          />
          <BannerStat
            label="AVG PACE"
            value={formatVelocity(migration?.velocityZecPerHour ?? 0)}
            color={CYAN}
          />
          <BannerStat
            label="ORCHARD LEFT"
            value={`${fmtCompactNumber(orchard)} ZEC`}
            color={ORCHARD}
          />
        </div>
        <div className="mt-2">
          <div className="mb-1 flex items-baseline justify-between gap-2 text-[9px] tracking-[0.13em]">
            <span style={{ color: ORCHARD }}>ORCHARD</span>
            <span style={{ color: IRONWOOD }}>IRONWOOD</span>
          </div>
          <SegmentBar pct={movedPct} color={IRONWOOD} restColor={ORCHARD} />
        </div>
      </div>
    </div>
  )
}

/** Segmented progress strip — matches the block-rail language used on the
 *  Ironwood tracker rather than a smooth bar. */
function SegmentBar({
  pct,
  color,
  restColor,
}: {
  pct: number
  color: string
  /** Colour for the unfilled run. Set for the Orchard/Ironwood split so the
   *  remainder reads as "still in Orchard" rather than empty track. */
  restColor?: string
}) {
  const segments = 28
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * segments)
  return (
    <div
      className="grid gap-px"
      style={{ gridTemplateColumns: `repeat(${segments}, minmax(0,1fr))` }}
      aria-hidden="true"
    >
      {Array.from({ length: segments }, (_, index) => {
        const on = index < filled
        return (
          <span
            key={index}
            className="h-2"
            style={{
              background: on ? color : restColor ?? paletteVar("text"),
              opacity: on ? 0.9 : restColor ? 0.55 : 0.12,
            }}
          />
        )
      })}
    </div>
  )
}

function BannerStat({
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
      <div
        className="truncate text-[8px] tracking-[0.14em]"
        style={{ opacity: 0.5 }}
      >
        {label}
      </div>
      <div
        className="mt-0.5 truncate text-[11px] font-bold tabular-nums"
        style={{ color: color ?? paletteVar("text") }}
        title={value}
      >
        {value}
      </div>
    </div>
  )
}

/* ── ZEC panel pill ─────────────────────────────────────────────────── */

/** Single-line Ironwood totals for the dashboard ZEC panel, sitting under the
 *  MINED / SHIELDED bars where the Orchard prediction-market pill used to be.
 *  Same h-5 chip geometry as the pool chips below it. */
export function IronwoodTotalsPill() {
  const { data, error } = useIronwood()

  if (error && !data) return null

  const migration = data?.migration ?? null
  // Pool balance, not cumulative migrated. Share of supply deliberately isn't
  // here — the IRONWD chip in the per-pool row directly below carries it, so
  // repeating it would duplicate the same percentage in adjacent rows. Tx count
  // is the thing that row can't show.
  const ironwoodPool = migration?.ironwoodZec ?? 0

  return (
    <Link
      href={IRONWOOD_HREF}
      className="group block focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
      style={{ outlineColor: IRONWOOD }}
      title="Open the live Ironwood tracker"
    >
      <div
        className="flex h-5 items-center gap-1.5 border px-1.5 text-[9px] font-bold leading-none tracking-[0.12em]"
        style={{
          borderColor: `${IRONWOOD}55`,
          background: `${IRONWOOD}08`,
          color: IRONWOOD,
        }}
      >
        <span className="min-w-0 truncate">IRONWOOD</span>
        <span className="ml-auto shrink-0 tabular-nums">
          {data == null ? (
            "SYNC"
          ) : (
            <>
              {fmtCompactNumber(ironwoodPool)} ZEC
              <span
                className="ml-1"
                style={{ color: paletteVar("text"), opacity: 0.62 }}
              >
                {(migration?.txCount ?? 0).toLocaleString("en-US")} TX
              </span>
            </>
          )}
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

/* ── Stats page chip ────────────────────────────────────────────────── */

export function IronwoodAtGlance() {
  const { data, error } = useIronwood()

  return (
    <Link
      href={IRONWOOD_HREF}
      // `min-w-0` rather than a floor: this sits in the ZEC banner's
      // three-column chip grid, where a grid item's default `min-width: auto`
      // resolves to min-content and an 8.5rem floor pushed the chip past the
      // card's edge on a 320-412px phone. The label below wraps instead.
      className="group block min-w-0 border px-2 py-1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
      style={{ borderColor: `${IRONWOOD}55`, outlineColor: IRONWOOD }}
      title="Open the live Ironwood tracker"
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
          {/* Wraps rather than forcing width. "86.7% MOVED" on two short
              lines beats a chip that overflows its card, and it is back to
              one line the moment the column has room. */}
          <div className="mt-0.5 text-[11px] font-bold tabular-nums" style={{ color: IRONWOOD }}>
            {data.activated
              ? activationLabel(data, true)
              : `${fmtCompactNumber(data.blocksRemaining)} BLOCKS`}
          </div>
          <div className="mt-1 grid grid-cols-12 gap-px" aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => {
              const on =
                index <
                Math.round(
                  ((data.activated ? 100 : data.approachProgressPct) / 100) * 12
                )
              return (
                <span
                  key={index}
                  className="h-1"
                  style={{
                    background: on ? IRONWOOD : paletteVar("text"),
                    opacity: on ? 0.9 : 0.12,
                  }}
                />
              )
            })}
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
