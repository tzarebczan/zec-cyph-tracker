"use client"

import { useEffect, useState } from "react"
import { Radio, ShieldCheck, Sparkles } from "lucide-react"
import type { IronwoodLiveOverview } from "@/lib/ironwood-live"
import { CornerBox } from "@/components/primitives"
import { paletteVar } from "@/components/theme"
import {
  countdownParts,
  fmtCompact,
  fmtZec,
  formatActivationTime,
} from "./utils"

const IRONWOOD = "#f6c945"
const ORCHARD = "#a78bfa"
const CYAN = "#67e8f9"

interface HeroProps {
  overview: IronwoodLiveOverview
  now: number
  celebrating: boolean
}

export function IronwoodHero({
  overview,
  now,
  celebrating,
}: HeroProps) {
  return (
    <div className="relative">
      {celebrating && <ActivationBurst />}
      {overview.activated ? (
        <MigrationHero overview={overview} />
      ) : (
        <CountdownHero overview={overview} now={now} />
      )}
    </div>
  )
}

function CountdownHero({
  overview,
  now,
}: {
  overview: IronwoodLiveOverview
  now: number
}) {
  // Rendered server-side and on first client paint in a fixed zone, then
  // swapped to the viewer's own zone once mounted — formatting in the local
  // zone during SSR would hydrate-mismatch.
  const [localTimeZone, setLocalTimeZone] = useState<string | null>(null)
  const remainingMs = Math.max(
    0,
    (overview.estimatedActivationAt ?? now) - now
  )
  const parts = countdownParts(remainingMs)
  const approachStart = overview.activationHeight - 1_000
  const approachPct = Math.max(
    0,
    Math.min(
      100,
      ((overview.tipHeight - approachStart) /
        (overview.activationHeight - approachStart)) *
        100
    )
  )
  const activationAt = overview.estimatedActivationAt
  // Local zone only — the formatted string already carries its zone
  // abbreviation, so a second Eastern row is the same instant twice.
  const localTime = activationAt
    ? formatActivationTime(
        activationAt,
        localTimeZone ?? "America/New_York"
      )
    : "--"

  useEffect(() => {
    setLocalTimeZone(
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
        "America/New_York"
    )
  }, [])

  return (
    <CornerBox
      color={IRONWOOD}
      className="overflow-hidden"
      style={{
        background: `linear-gradient(110deg, ${ORCHARD}08, transparent 38%, ${IRONWOOD}08)`,
      }}
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(22rem,0.7fr)] lg:items-end">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 border px-2 py-1 text-[9px] font-bold tracking-[0.18em]"
              style={{ color: IRONWOOD, borderColor: `${IRONWOOD}66` }}
            >
              <Radio
                aria-hidden="true"
                size={11}
                className="cz-led-pulse"
              />
              FINAL APPROACH
            </span>
            <span className="text-[9px] tracking-[0.16em]" style={{ opacity: 0.52 }}>
              NU6.3 // MAINNET
            </span>
          </div>
          {/* h2, not h1 — the page's h1 is the "IRONWOOD // LIVE" header
              above this hero. */}
          <h2 className="mt-3 text-[clamp(1.45rem,4vw,3.25rem)] font-bold leading-[0.98]">
            IRONWOOD ACTIVATES AT
            <span
              className="mt-1 block tabular-nums"
              style={{
                color: IRONWOOD,
                textShadow: `0 0 14px ${IRONWOOD}44`,
              }}
            >
              BLOCK {overview.activationHeight.toLocaleString("en-US")}
            </span>
          </h2>
          <div className="mt-4 grid grid-cols-4 gap-px sm:max-w-2xl">
            {parts.map((part) => (
              <div
                key={part.label}
                className="border px-2 py-2 sm:px-3 sm:py-3"
                style={{
                  borderColor: `${IRONWOOD}38`,
                  background: `${IRONWOOD}08`,
                }}
              >
                <div
                  className="text-[clamp(1.2rem,5vw,2.25rem)] font-bold leading-none tabular-nums"
                  style={{ color: IRONWOOD }}
                >
                  {String(part.value).padStart(2, "0")}
                </div>
                <div className="mt-1 text-[8px] tracking-[0.18em]" style={{ opacity: 0.5 }}>
                  {part.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-3 border-t pt-4 lg:border-t-0 lg:border-l lg:pl-5 lg:pt-0" style={{ borderColor: `${IRONWOOD}28` }}>
          <div className="grid grid-cols-2 gap-3">
            <HeroStat
              label="BLOCKS LEFT"
              value={overview.blocksUntilActivation.toLocaleString("en-US")}
              color={IRONWOOD}
            />
            <HeroStat
              label="OBSERVED BLOCK"
              value={`${overview.avgBlockTimeSecs.toFixed(1)} SEC`}
            />
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[9px] tracking-[0.15em]">
              <span style={{ opacity: 0.52 }}>FINAL 1,000 BLOCKS</span>
              <span className="tabular-nums" style={{ color: IRONWOOD }}>
                {approachPct.toFixed(1)}%
              </span>
            </div>
            <div className="grid grid-cols-[repeat(32,minmax(0,1fr))] gap-px">
              {Array.from({ length: 32 }, (_, index) => {
                const on = index < Math.round((approachPct / 100) * 32)
                return (
                  <span
                    key={index}
                    className="h-2.5"
                    style={{
                      background: on
                        ? index > 23
                          ? IRONWOOD
                          : ORCHARD
                        : paletteVar("text"),
                      opacity: on ? 0.9 : 0.1,
                    }}
                  />
                )
              })}
            </div>
          </div>
          <div className="grid gap-2 text-[10px] leading-relaxed">
            <TimeRow label="ACTIVATION" value={localTime} />
          </div>
          <div className="text-[9px] leading-relaxed" style={{ opacity: 0.46 }}>
            ESTIMATE RECALCULATES FROM THE LIVE TIP AND OBSERVED BLOCK INTERVAL.
          </div>
        </div>
      </div>
    </CornerBox>
  )
}

function MigrationHero({ overview }: { overview: IronwoodLiveOverview }) {
  const migration = overview.migration
  const migrationPoolTotal =
    overview.poolSizes.orchardZec + overview.poolSizes.ironwoodZec
  const orchardShare =
    migrationPoolTotal > 0
      ? (overview.poolSizes.orchardZec / migrationPoolTotal) * 100
      : 0
  const ironwoodShare =
    migrationPoolTotal > 0
      ? (overview.poolSizes.ironwoodZec / migrationPoolTotal) * 100
      : 0
  // Migration progress must count only Orchard-sourced value. Ironwood also
  // receives Sapling / transparent / coinbase inflow that was never in Orchard,
  // so a pool-based share (upstream's migratedPercent) overstates how far
  // Orchard has drained — that's the gap between 5.07% and cipherscan's 4.30%.
  const fromOrchardZec = overview.inflowSources.fromOrchardZec
  const orchardBase = overview.poolSizes.orchardZec + fromOrchardZec
  const orchardMigratedPct =
    orchardBase > 0 ? (fromOrchardZec / orchardBase) * 100 : 0

  return (
    <CornerBox
      color={IRONWOOD}
      className="overflow-hidden"
      style={{
        background: `linear-gradient(105deg, ${ORCHARD}0b, transparent 44%, ${IRONWOOD}0c)`,
      }}
    >
      <div>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 border px-2 py-1 text-[9px] font-bold tracking-[0.18em]"
              style={{
                color: paletteVar("cyph"),
                borderColor: `${paletteVar("cyph")}66`,
              }}
            >
              <ShieldCheck aria-hidden="true" size={11} />
              IRONWOOD LIVE
            </span>
            <span className="text-[9px] tracking-[0.16em]" style={{ opacity: 0.52 }}>
              ACTIVATED AT #{overview.activationHeight.toLocaleString("en-US")}
            </span>
          </div>
          <h2 className="mt-2 whitespace-nowrap text-[1rem] font-bold leading-none sm:mt-3 sm:text-[1.55rem] md:text-[2.15rem] lg:text-[2.6rem] xl:text-[3.2rem]">
            ORCHARD
            <span style={{ color: ORCHARD }}> //</span>
            <span style={{ color: IRONWOOD }}>
              {" "}
              IRONWOOD MIGRATION
            </span>
          </h2>
          {/* Headline progress figure. Orchard-sourced only, so it agrees with
              cipherscan's ORCHARD → IRONWOOD rather than the pool share. */}
          <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className="text-[clamp(1.75rem,7vw,3rem)] font-bold leading-none tabular-nums"
              style={{ color: IRONWOOD, textShadow: `0 0 12px ${IRONWOOD}44` }}
            >
              {orchardMigratedPct < 0.01 && orchardMigratedPct > 0
                ? "<0.01%"
                : `${orchardMigratedPct.toFixed(2)}%`}
            </span>
            <span
              className="text-[9px] leading-relaxed tracking-[0.16em]"
              style={{ opacity: 0.55 }}
            >
              OF ORCHARD MIGRATED
              <span className="block" style={{ opacity: 0.75 }}>
                {fmtZec(fromOrchardZec, 0)} ZEC SOURCED FROM ORCHARD
              </span>
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-px border sm:mt-5 lg:grid-cols-4" style={{ borderColor: `${IRONWOOD}30` }}>
        {/* Cumulative inflow, which runs ahead of the pool balance once value
            starts leaving Ironwood again. migratedPercent is derived from the
            pool, so it belongs on the pool stat, not here. */}
        <LaunchStat
          label="MIGRATED"
          value={`${fmtCompact(migration.totalMigratedZec)} ZEC`}
          sub="CUMULATIVE INFLOW"
          color={IRONWOOD}
        />
        <LaunchStat
          label="MIGRATION TX"
          value={migration.txCount.toLocaleString("en-US")}
          sub={`LATEST #${(migration.lastHeight ?? overview.tipHeight).toLocaleString("en-US")}`}
          color={CYAN}
        />
        <LaunchStat
          label="AVG PACE"
          value={`${fmtCompact(migration.velocityZecPerHour)} ZEC/H`}
          sub="MEAN SINCE FIRST MIGRATION"
        />
        {/* No percentage here on purpose — the hero above carries the one
            migration figure, and a pool-share percentage beside it invites
            exactly the 4.30-vs-5.07 confusion this change removes. */}
        <LaunchStat
          label="IRONWOOD POOL"
          value={`${fmtCompact(overview.poolSizes.ironwoodZec)} ZEC`}
          sub={`${fmtCompact(overview.poolSizes.orchardZec)} ZEC REMAINS IN ORCHARD`}
          color={paletteVar("cyph")}
        />
      </div>

      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:mt-4">
        <PoolSide
          label="ORCHARD"
          value={`${fmtZec(overview.poolSizes.orchardZec)} ZEC`}
          color={ORCHARD}
          percent={orchardShare}
        />
        <div
          className="grid min-h-10 min-w-16 place-items-center border px-2 text-center sm:min-h-12 sm:min-w-20"
          style={{ borderColor: `${IRONWOOD}66`, color: IRONWOOD }}
        >
          <span className="text-[8px] tracking-[0.15em]">TURNSTILE</span>
          <span className="text-xs font-bold">OPEN</span>
        </div>
        <PoolSide
          label="IRONWOOD"
          value={`${fmtZec(overview.poolSizes.ironwoodZec)} ZEC`}
          color={IRONWOOD}
          percent={ironwoodShare}
          align="right"
        />
      </div>
    </CornerBox>
  )
}

function HeroStat({
  label,
  value,
  color,
}: {
  label: string
  value: string
  color?: string
}) {
  return (
    <div>
      <div className="text-[9px] tracking-[0.15em]" style={{ opacity: 0.5 }}>
        {label}
      </div>
      <div
        className="mt-0.5 text-base font-bold tabular-nums"
        style={{ color: color ?? paletteVar("text") }}
      >
        {value}
      </div>
    </div>
  )
}

function TimeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-2">
      <span style={{ opacity: 0.5 }}>{label}</span>
      <span className="min-w-0 text-right font-bold tabular-nums" style={{ color: IRONWOOD }}>
        {value}
      </span>
    </div>
  )
}

function LaunchStat({
  label,
  value,
  sub,
  color,
}: {
  label: string
  value: string
  sub: string
  color?: string
}) {
  return (
    <div
      className="min-w-0 px-2.5 py-2 sm:px-3 sm:py-3"
      style={{ background: `${color ?? CYAN}08` }}
    >
      <div className="text-[8px] tracking-[0.16em]" style={{ opacity: 0.5 }}>
        {label}
      </div>
      <div
        className="mt-0.5 truncate text-lg font-bold tabular-nums sm:mt-1"
        style={{ color: color ?? paletteVar("text") }}
        title={value}
      >
        {value}
      </div>
      <div className="mt-0.5 truncate text-[8px] tracking-[0.08em] sm:mt-1" style={{ opacity: 0.42 }}>
        {sub}
      </div>
    </div>
  )
}

function PoolSide({
  label,
  value,
  color,
  percent,
  align = "left",
}: {
  label: string
  value: string
  color: string
  percent: number
  align?: "left" | "right"
}) {
  return (
    <div className={align === "right" ? "text-right" : ""}>
      <div className="text-[8px] tracking-[0.18em]" style={{ color }}>
        {label}
      </div>
      <div className="mt-1 truncate text-[11px] font-bold tabular-nums" title={value}>
        {value}
      </div>
      <div className="mt-1 h-1.5" style={{ background: `${color}18` }}>
        <div
          className="h-full transition-[width]"
          style={{
            width: `${Math.max(percent > 0 ? 1 : 0, Math.min(100, percent))}%`,
            background: color,
            opacity: 0.8,
          }}
        />
      </div>
    </div>
  )
}

function ActivationBurst() {
  return (
    <div
      className="cz-ironwood-burst pointer-events-none absolute inset-x-0 -top-16 z-40 h-80 overflow-hidden"
      aria-hidden="true"
    >
      {Array.from({ length: 48 }, (_, index) => (
        <span
          key={index}
          className="absolute top-0 block h-2 w-1"
          style={{
            left: `${(index * 37) % 100}%`,
            background: [IRONWOOD, ORCHARD, CYAN, paletteVar("cyph")][index % 4],
            animationDelay: `${(index % 12) * 70}ms`,
            animationDuration: `${1_800 + (index % 7) * 170}ms`,
            transform: `rotate(${(index * 29) % 180}deg)`,
          }}
        />
      ))}
    </div>
  )
}
