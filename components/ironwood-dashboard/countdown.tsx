"use client"

import { useEffect, useState } from "react"
import { Blocks, Clock3, Radio, ShieldCheck, Sparkles } from "lucide-react"
import type {
  IronwoodBlock,
  IronwoodLiveOverview,
} from "@/lib/ironwood-live"
import { CornerBox } from "@/components/primitives"
import { paletteVar } from "@/components/theme"
import {
  ageLabel,
  countdownParts,
  fmtBytes,
  fmtCompact,
  fmtZec,
  formatActivationTime,
} from "./utils"

const IRONWOOD = "#f6c945"
const ORCHARD = "#a78bfa"
const CYAN = "#67e8f9"

interface HeroProps {
  overview: IronwoodLiveOverview
  blocks: IronwoodBlock[]
  now: number
  selectedBlock: number | null
  onSelectBlock: (height: number) => void
  celebrating: boolean
}

export function IronwoodHero({
  overview,
  blocks,
  now,
  selectedBlock,
  onSelectBlock,
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
      <BlockApproachRail
        blocks={blocks}
        overview={overview}
        now={now}
        selectedBlock={selectedBlock}
        onSelectBlock={onSelectBlock}
      />
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
          <h2 className="mt-2 text-[1.55rem] font-bold leading-none sm:mt-3 sm:text-[2.15rem] lg:text-[3.2rem]">
            ORCHARD
            <span style={{ color: ORCHARD }}> //</span>
            <span className="block sm:inline" style={{ color: IRONWOOD }}>
              {" "}
              IRONWOOD MIGRATION
            </span>
          </h2>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-px border sm:mt-5 lg:grid-cols-4" style={{ borderColor: `${IRONWOOD}30` }}>
        <LaunchStat
          label="MIGRATED"
          value={`${fmtCompact(migration.totalMigratedZec)} ZEC`}
          sub={`${migration.migratedPercent.toFixed(2)}% OF ORCHARD + IRONWOOD`}
          color={IRONWOOD}
        />
        <LaunchStat
          label="MIGRATION TX"
          value={migration.txCount.toLocaleString("en-US")}
          sub={`LATEST #${(migration.lastHeight ?? overview.tipHeight).toLocaleString("en-US")}`}
          color={CYAN}
        />
        <LaunchStat
          label="VELOCITY"
          value={`${fmtCompact(migration.velocityZecPerHour)} ZEC/H`}
          sub="OBSERVED SINCE FIRST MIGRATION"
        />
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

function BlockApproachRail({
  blocks,
  overview,
  now,
  selectedBlock,
  onSelectBlock,
}: {
  blocks: IronwoodBlock[]
  overview: IronwoodLiveOverview
  now: number
  selectedBlock: number | null
  onSelectBlock: (height: number) => void
}) {
  const ordered = [...blocks].sort((a, b) => a.height - b.height)
  const selected =
    ordered.find((block) => block.height === selectedBlock) ??
    ordered.at(-1) ??
    null
  const maxTransactions = Math.max(
    1,
    ...ordered.map((block) => block.txCount)
  )

  return (
    <CornerBox
      color={overview.activated ? paletteVar("cyph") : CYAN}
      className="mt-2 sm:mt-3"
      label={
        <span className="inline-flex items-center gap-1.5">
          <Blocks aria-hidden="true" size={12} />
          LIVE BLOCK RAIL
        </span>
      }
      action={
        <span className="inline-flex items-center gap-1">
          <span className="cz-led-pulse inline-block size-1.5 rounded-full" style={{ background: paletteVar("cyph") }} />
          TIP {overview.tipHeight.toLocaleString("en-US")}
        </span>
      }
    >
      <div className="mt-2 overflow-x-auto pb-1 pt-1">
        <div className="flex min-w-max gap-1">
          {ordered.map((block, index) => {
            const active = selected?.height === block.height
            const latest = index === ordered.length - 1
            const activityWidth = Math.max(
              block.txCount > 0 ? 8 : 0,
              (block.txCount / maxTransactions) * 100
            )
            return (
              <button
                key={block.hash}
                type="button"
                onClick={() => onSelectBlock(block.height)}
                className="group relative grid h-[62px] w-[64px] shrink-0 grid-rows-[auto_auto_1fr] border px-2 py-1.5 text-left transition-[transform,background-color] hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                style={{
                  color: active || latest ? CYAN : paletteVar("text"),
                  borderColor: active ? CYAN : `${paletteVar("text")}38`,
                  background: active ? `${CYAN}10` : "transparent",
                  outlineColor: CYAN,
                }}
                aria-label={`Block ${block.height}, ${block.txCount} transactions, ${ageLabel(block.timestamp, now)} old`}
                title={`Block ${block.height.toLocaleString("en-US")} - ${block.txCount} transactions`}
              >
                {latest && (
                  <span
                    className="absolute right-1 top-1 size-1.5 rounded-full cz-led-pulse"
                    style={{ background: paletteVar("cyph") }}
                  />
                )}
                <span className="block text-[8px] tabular-nums" style={{ opacity: 0.55 }}>
                  {ageLabel(block.timestamp, now)}
                </span>
                <span className="mt-0.5 block text-[10px] font-bold tabular-nums">
                  {String(block.height).slice(-5)}
                </span>
                <span className="block text-[8px]" style={{ opacity: 0.55 }}>
                  {block.txCount} TX
                </span>
                <span
                  aria-hidden="true"
                  className="absolute inset-x-2 bottom-1.5 h-1 overflow-hidden"
                  style={{ background: `${CYAN}12` }}
                >
                  <span
                    className="block h-full"
                    style={{
                      width: `${Math.min(100, activityWidth)}%`,
                      background: active ? CYAN : paletteVar("cyph"),
                      opacity: active ? 1 : 0.72,
                    }}
                  />
                </span>
              </button>
            )
          })}
          <div
            className="grid h-[62px] w-[76px] shrink-0 place-items-center border px-2 text-center"
            style={{
              borderColor: `${IRONWOOD}88`,
              color: IRONWOOD,
              background: `${IRONWOOD}08`,
            }}
          >
            <div>
              <Sparkles aria-hidden="true" size={13} className="mx-auto mb-1" />
              <div className="text-[8px] tracking-[0.12em]">
                {overview.activated ? "ACTIVATED" : "IRONWOOD"}
              </div>
              <div className="text-[9px] font-bold tabular-nums">
                {String(overview.activationHeight).slice(-5)}
              </div>
            </div>
          </div>
        </div>
      </div>
      {selected && (
        <div
          className="mt-2 grid grid-cols-[minmax(5.5rem,1.35fr)_repeat(4,minmax(0,0.7fr))] gap-x-2 border-t pt-2 sm:grid-cols-[minmax(9rem,1.4fr)_repeat(4,minmax(4rem,1fr))] sm:gap-x-4"
          style={{ borderColor: `${CYAN}25` }}
        >
          <RailStat
            label="SELECTED BLOCK"
            value={`#${selected.height.toLocaleString("en-US")}`}
            color={CYAN}
          />
          <RailStat label="TX" value={selected.txCount.toLocaleString("en-US")} />
          <RailStat label="SIZE" value={fmtBytes(selected.size)} />
          <RailStat
            label="FEES"
            value={`${fmtZec(selected.feesZec, 5)} ZEC`}
          />
          <RailStat label="AGE" value={ageLabel(selected.timestamp, now)} />
        </div>
      )}
      <div
        className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[9px]"
        style={{ opacity: 0.5 }}
      >
        <span>TAP A BLOCK TO INSPECT</span>
        <span className="inline-flex items-center gap-1 tabular-nums">
          <Clock3 aria-hidden="true" size={10} />
          {overview.blocksUntilActivation.toLocaleString("en-US")} TO GATE
        </span>
      </div>
    </CornerBox>
  )
}

function RailStat({
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
        className="text-[8px] tracking-[0.13em]"
        style={{ opacity: 0.45 }}
      >
        {label}
      </div>
      <div
        className="mt-0.5 truncate text-[10px] font-bold tabular-nums sm:text-[11px]"
        style={{ color: color ?? paletteVar("text") }}
        title={value}
      >
        {value}
      </div>
    </div>
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
