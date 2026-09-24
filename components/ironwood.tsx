"use client"

import Link from "next/link"
import { ArrowRight, Radio, ShieldCheck } from "lucide-react"
import useSWR from "swr"
import type { ShieldingSummaryResponse, ZecStatsResponse } from "./api-types"
import { CornerBox, Skeleton } from "./primitives"
import { fmtCompactNumber, swrFetcher } from "./format"
import { E_STATIC, paletteVar } from "./theme"

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
   so it can carry two live stories without shrinking the CYPH/ZEC/RATIO
   readouts that are the page's primary content.

   Two halves, each its own link: IRONWOOD (how far the Orchard → Ironwood
   migration has got) and SHIELDING (what moved in and out of the shielded
   pools in the last day). The migration used to have the whole strip and
   four stats; it is one number and a bar now, with the freed room going to
   the flows, which change every hour where the migration share moves once
   a day.

   The pre-activation countdown that used to live here is gone: NU6.3
   activated at block 3,428,143 and that's a one-way transition. */
const SHIELDING_HREF = "/shielding"
const SHIELD = "#67e8f9"

/** All pools, not just Ironwood: the banner answers "is ZEC going shielded
 *  today", and that is the whole shielded set. `summary` keeps it to the
 *  totals; the full payload is half a megabyte. */
function useShieldingSummary() {
  return useSWR<ShieldingSummaryResponse>(
    "/api/shielding-details?pool=all&summary",
    swrFetcher,
    {
      refreshInterval: 60_000,
      keepPreviousData: true,
      revalidateOnFocus: true,
    }
  )
}

export function IronwoodBanner() {
  const { data, error } = useIronwood()
  const { data: shielding, error: shieldingError } = useShieldingSummary()
  // Same key and cadence the dashboard already uses for the ZEC tile, so
  // this is a cache read rather than a second request.
  const { data: zecStats } = useSWR<ZecStatsResponse>("/api/zec-stats", swrFetcher, {
    refreshInterval: 5 * 60_000,
    keepPreviousData: true,
  })

  if (error && !data && shieldingError && !shielding) return null

  return (
    <CornerBox
      color={IRONWOOD}
      className="mb-2 md:mb-3"
      style={{
        background: `linear-gradient(100deg, ${ORCHARD}0b, transparent 40%, ${SHIELD}0a)`,
      }}
    >
      {/* Two columns at every width. On phones each half is a headline and
          one line of figures; the bars and stat grids only appear from md. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-6">
        <Link
          href={IRONWOOD_HREF}
          className="group block min-w-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
          style={{ outlineColor: IRONWOOD }}
          title="Open the live Ironwood tracker"
        >
          <BannerHeader
            title="IRONWOOD"
            chip="MIGRATING"
            color={IRONWOOD}
            stale={data?.stale}
            cta="TRACK LIVE"
          />
          {/* min-h matches the rendered summary (53px at every width) so the
              banner does not shrink when the data replaces the skeleton. */}
          <div className="min-h-[53px]">
            {!data ? (
              <Skeleton className="mt-2 align-top" height={45} />
            ) : (
              <MigrationSummary data={data} />
            )}
          </div>
        </Link>

        <Link
          href={SHIELDING_HREF}
          className="group block min-w-0 border-l pl-3 md:pl-6 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
          style={{ outlineColor: SHIELD, borderColor: `${paletteVar("text")}22` }}
          title="Open shielding flows"
        >
          <BannerHeader
            title="SHIELDING"
            chip="24H"
            color={SHIELD}
            icon={<ShieldCheck aria-hidden="true" size={9} />}
            stale={shielding?.stale}
            cta="FLOWS"
          />
          {/* The shielding summary wraps to a second figure line on phones
              (64px) and sits on one line from md up (53px). */}
          <div className="min-h-[64px] md:min-h-[53px]">
            {!shielding ? (
              <Skeleton className="mt-2 align-top" height={45} />
            ) : (
              <ShieldingSummary data={shielding} shieldedPct={zecStats?.shieldedPct ?? null} />
            )}
          </div>
        </Link>
      </div>
    </CornerBox>
  )
}

function BannerHeader({
  title,
  chip,
  color,
  icon,
  stale,
  cta,
}: {
  title: string
  chip: string
  color: string
  icon?: React.ReactNode
  stale?: boolean
  cta: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="text-[11px] font-bold tracking-[0.22em]"
        style={{ color, textShadow: `0 0 6px ${color}55` }}
      >
        {title}
      </span>
      <span
        className="box-border hidden h-[18px] items-center gap-1 border px-1.5 text-[9px] font-bold leading-none tracking-[0.1em] sm:inline-flex"
        style={{ borderColor: `${color}55`, color }}
      >
        {icon ?? <Radio aria-hidden="true" size={9} className="cz-led-pulse" />}
        {chip}
      </span>
      {stale && (
        <span className="hidden text-[9px] tracking-[0.12em] sm:inline" style={{ opacity: 0.5 }}>
          CACHE
        </span>
      )}
      <span
        className="ml-auto inline-flex shrink-0 items-center gap-1 text-[9px] font-bold tracking-[0.12em]"
        style={{ color }}
      >
        <span className="hidden sm:inline">{cta}</span>
        <ArrowRight
          aria-hidden="true"
          size={11}
          strokeWidth={1.8}
          className="transition-transform group-hover:translate-x-0.5"
        />
      </span>
    </div>
  )
}

/** Condensed migration: the share moved, the split bar, and one line of
 *  totals. Pace and tx count live on the tracker page now. */
function MigrationSummary({ data }: { data: IronwoodResponse }) {
  const migration = data.migration
  const orchard = migration?.orchardZec ?? 0
  const ironwood = migration?.ironwoodZec ?? 0
  // Orchard-sourced progress, not the whole Ironwood pool. Ironwood also takes
  // Sapling / transparent inflow that was never in Orchard, so pool-based
  // shares overstate the migration. Falls back to the pool share only for
  // stale pre-v4 payloads.
  const base = orchard + ironwood
  const movedPct =
    migration?.orchardMigratedPct ??
    migration?.migratedPercent ??
    (base > 0 ? (ironwood / base) * 100 : 0)

  return (
    <div className="mt-2 flex items-end gap-3">
      <div className="min-w-0 shrink-0 max-md:flex-1">
        <div
          className="text-[clamp(1.35rem,6vw,2.1rem)] font-bold leading-none tabular-nums"
          style={{ color: IRONWOOD, textShadow: `0 0 10px ${IRONWOOD}44` }}
        >
          {formatMovedPct(movedPct)}
        </div>
        <div className="mt-0.5 text-[8px] tracking-[0.16em]" style={{ opacity: 0.5 }}>
          OF ORCHARD MOVED
        </div>
        {/* Phone-only figures; the bar and its labels take over from md. */}
        <div className="mt-1 flex flex-wrap gap-x-2 text-[9px] leading-tight tracking-[0.08em] tabular-nums md:hidden">
          <span className="whitespace-nowrap">
            <span style={{ color: IRONWOOD }}>{fmtCompactNumber(ironwood)}</span>
            <span style={{ opacity: 0.5 }}> IRONWD</span>
          </span>
          <span className="whitespace-nowrap">
            <span style={{ color: ORCHARD }}>{fmtCompactNumber(orchard)}</span>
            <span style={{ opacity: 0.5 }}> LEFT</span>
          </span>
        </div>
      </div>
      <div className="hidden min-w-0 flex-1 md:block">
        <div className="mb-1 flex items-baseline justify-between gap-2 text-[9px] tracking-[0.13em] tabular-nums">
          <span style={{ color: ORCHARD }}>
            {fmtCompactNumber(orchard)} <span style={{ opacity: 0.7 }}>LEFT</span>
          </span>
          <span style={{ color: IRONWOOD }}>
            {fmtCompactNumber(ironwood)} <span style={{ opacity: 0.7 }}>IRONWOOD</span>
          </span>
        </div>
        <SegmentBar pct={movedPct} color={IRONWOOD} restColor={ORCHARD} />
        <div className="mt-1 text-[8px] tracking-[0.14em] tabular-nums" style={{ opacity: 0.5 }}>
          {(migration?.txCount ?? 0).toLocaleString("en-US")} MIGRATION TX
          {migration?.velocityZecPerHour ? ` · ${formatVelocity(migration.velocityZecPerHour)} AVG` : ""}
        </div>
      </div>
    </div>
  )
}

/** Last-24h flows across every shielded pool: the net figure leads, the
 *  gross in/out with their tx counts explain it, and the shielded share of
 *  supply says where that leaves the chain. */
function ShieldingSummary({
  data,
  shieldedPct,
}: {
  data: ShieldingSummaryResponse
  shieldedPct: number | null
}) {
  const day = data.totals.last24h
  const net = day.netZec
  const netColor = net >= 0 ? paletteVar("cyph") : E_STATIC.red
  const gross = day.inZec + day.outZec
  const inShare = gross > 0 ? (day.inZec / gross) * 100 : 50

  return (
    <div className="mt-2 flex items-end gap-3">
      <div className="min-w-0 shrink-0 max-md:flex-1">
        <div
          className="text-[clamp(1.35rem,6vw,2.1rem)] font-bold leading-none tabular-nums"
          style={{ color: netColor, textShadow: `0 0 10px ${netColor}44` }}
        >
          {net >= 0 ? "+" : "−"}
          {fmtCompactNumber(Math.abs(net))}
        </div>
        <div className="mt-0.5 text-[8px] tracking-[0.16em]" style={{ opacity: 0.5 }}>
          NET ZEC SHIELDED · 24H
        </div>
        <div className="mt-1 flex flex-wrap gap-x-2 text-[9px] leading-tight tracking-[0.08em] tabular-nums md:hidden">
          <span className="whitespace-nowrap">
            <span style={{ color: paletteVar("cyph") }}>{fmtCompactNumber(day.inZec)}</span>
            <span style={{ opacity: 0.5 }}> IN</span>
          </span>
          <span className="whitespace-nowrap">
            <span style={{ color: E_STATIC.red }}>{fmtCompactNumber(day.outZec)}</span>
            <span style={{ opacity: 0.5 }}> OUT</span>
          </span>
          {shieldedPct != null && (
            <span className="whitespace-nowrap">
              <span style={{ color: SHIELD }}>{shieldedPct.toFixed(1)}%</span>
              <span style={{ opacity: 0.5 }}> SHIELDED</span>
            </span>
          )}
        </div>
      </div>
      <div className="hidden min-w-0 flex-1 md:block">
        <div className="grid grid-cols-3 gap-2">
          {/* Short labels: three cells share ~300px on a phone and "UNSHIELDED
              OUT 10.47K ZEC" truncated to nothing useful. The headline says
              ZEC and 24H once for all three. */}
          <BannerStat
            label="IN"
            value={fmtCompactNumber(day.inZec)}
            sub={`${day.inTx.toLocaleString("en-US")} TX`}
            color={paletteVar("cyph")}
          />
          <BannerStat
            label="OUT"
            value={fmtCompactNumber(day.outZec)}
            sub={`${day.outTx.toLocaleString("en-US")} TX`}
            color={E_STATIC.red}
          />
          <BannerStat
            label="OF SUPPLY"
            value={shieldedPct != null ? `${shieldedPct.toFixed(1)}%` : "—"}
            sub={`${fmtCompactNumber(data.totals.sinceActivation.inTx + data.totals.sinceActivation.outTx)} TX ${data.activation.label}`}
            color={SHIELD}
          />
        </div>
        {/* In vs out split for the day, same idiom as the pool bar beside it. */}
        <div className="mt-1.5">
          <SegmentBar pct={inShare} color={paletteVar("cyph")} restColor={E_STATIC.red} align="left" />
        </div>
      </div>
    </div>
  )
}

/** Segmented split — remainder under the left ORCHARD label, migrated under
 *  the right IRONWOOD label, rather than a left-filling progress meter. */
function SegmentBar({
  pct,
  color,
  restColor,
  align = "right",
}: {
  pct: number
  color: string
  /** Colour for the unfilled run. Set for the Orchard/Ironwood split so the
   *  remainder reads as "still in Orchard" rather than empty track. */
  restColor?: string
  /** Which end the filled run sits at. The migration fills from the right
   *  (under its IRONWOOD label); the shielding in/out split fills from the
   *  left (IN first, OUT after). */
  align?: "left" | "right"
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
        const on = align === "left" ? index < filled : index >= segments - filled
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
  sub,
}: {
  label: string
  value: string
  color?: string
  sub?: string
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
      {sub && (
        <div className="truncate text-[8px] tracking-[0.1em] tabular-nums" style={{ opacity: 0.45 }}>
          {sub}
        </div>
      )}
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
