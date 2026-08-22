"use client"

import { useEffect, useId, useMemo, useRef, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { usePageVisible } from "@/hooks/use-page-visible"
import { CornerBox, InfoTip, LiveNumber, Skeleton } from "./primitives"
import { paletteVar, withAlpha, E_STATIC } from "./theme"
import { fmtCompactUSD, fmtPct, swrFetcher } from "./format"
import { DEPTH_STATS_VIEW } from "./zec-views"
import type {
  DepthBin,
  DepthMicroStats,
  DepthWall,
  PricesHistoryPoint,
  TapePrint,
  ZecDepthResponse,
} from "./api-types"

// ---------------------------------------------------------------------------
// Aggregated order-book depth UI.
//
// One data source (/api/zec-depth, see that route for how six venue books are
// stitched into one), three surfaces:
//   • <DepthStrip>   — the compact strip that lives inside the ZEC tile.
//   • <DepthSection> — the full-width dashboard section, for when the tile is
//                      too narrow to be useful (i.e. desktop).
//   • <OrderFlowPanels> — /stats -> ZEC -> ORDER FLOW, the everything view.
//
// All three share the poll (single SWR key, so two of them on one page is
// still one request) and the same tween/flash machinery below.
// ---------------------------------------------------------------------------

/** Poll cadence. Fast enough to feel live, slow enough that the route's 5 s
 *  server-side cache absorbs concurrent viewers into one upstream fan-out. */
const POLL_MS = 6_000
const TWEEN_MS = 620
/** A print at or above this notional gets the loud treatment: a blip pill
 *  plus a flash on its side of the depth chart. */
const BIG_PRINT_USD = 50_000
/** Imbalance has to move at least this much between polls to earn a sweep. */
const MOMENTUM_DELTA = 0.06

// ---------- data + motion --------------------------------------------------

/** Shared fetch. Every consumer is rendered conditionally, so "hidden costs
 *  nothing" comes from the component not being mounted rather than from a
 *  null SWR key. Polling pauses while the tab is in the background, and the
 *  single shared key means two surfaces on one page are still one request. */
function useZecDepth() {
  const visible = usePageVisible()
  return useSWR<ZecDepthResponse>("/api/zec-depth", swrFetcher, {
    refreshInterval: visible ? POLL_MS : 0,
    dedupingInterval: 3_000,
    keepPreviousData: true,
  })
}

type MotionPref = "full" | "subtle" | "off"

/** Read the motion preference straight off `<html data-cz-motion>` rather
 *  than mounting `useCyphzecSettings` — this component tree only needs to
 *  *read* the value, and the settings hook writes to localStorage and
 *  broadcasts on every change. */
function useMotionPref(): MotionPref {
  const [pref, setPref] = useState<MotionPref>("full")
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)")
    // The OS preference wins over the site setting, and is re-checked on
    // every read — otherwise any later settings broadcast would quietly
    // promote a reduced-motion user back to "full".
    const read = () => {
      if (reduce.matches) {
        setPref("off")
        return
      }
      const v = document.documentElement.dataset.czMotion
      setPref(v === "off" ? "off" : v === "subtle" ? "subtle" : "full")
    }
    read()
    window.addEventListener("cyphzec:settings", read)
    reduce.addEventListener("change", read)
    return () => {
      window.removeEventListener("cyphzec:settings", read)
      reduce.removeEventListener("change", read)
    }
  }, [])
  return pref
}

/**
 * rAF-tween an array of numbers toward `target`.
 *
 * This is what makes the depth curve *move* instead of teleporting once
 * every poll: each new response glides into place over ~600 ms. Interrupted
 * tweens resume from wherever the last frame left off (via `liveRef`) so a
 * fast sequence of polls never snaps backwards.
 *
 * Returns `target` untouched when disabled, or when the array length changed
 * (nothing sensible to interpolate against). A backgrounded tab needs no
 * special case: the browser stops servicing rAF, so the tween simply doesn't
 * advance, and the next visible poll lands on the correct values.
 */
function useTweenedArray(target: number[], enabled: boolean): number[] {
  const [frame, setFrame] = useState(target)
  const liveRef = useRef(target)
  const rafRef = useRef(0)

  useEffect(() => {
    if (!enabled || liveRef.current.length !== target.length) {
      liveRef.current = target
      setFrame(target)
      return
    }
    const from = liveRef.current
    if (from.every((v, i) => v === target[i])) return
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TWEEN_MS)
      // easeOutCubic — quick departure, soft landing.
      const e = 1 - Math.pow(1 - t, 3)
      const next = target.map((v, i) => from[i] + (v - from[i]) * e)
      liveRef.current = next
      setFrame(next)
      if (t < 1) rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafRef.current)
  }, [target, enabled])

  return enabled ? frame : target
}

interface DepthPulse {
  /** Prints first seen on the most recent poll, newest first. */
  fresh: TapePrint[]
  /** The loudest fresh print, if any cleared BIG_PRINT_USD. */
  big: TapePrint | null
  /** Signed imbalance move since the previous poll. */
  imbalanceDelta: number
  /** Bumped whenever a momentum sweep should replay. */
  sweepKey: number
}

/**
 * Diff consecutive polls into the events the UI animates on.
 *
 * The API is stateless — it always returns the last ~10 minutes of large
 * prints — so "what just happened" has to be derived on the client by
 * remembering which trade ids we've already shown. The seen-set is capped so
 * a long session doesn't grow it without bound.
 */
function useDepthPulse(data: ZecDepthResponse | undefined): DepthPulse {
  const seenRef = useRef<Set<string>>(new Set())
  const primedRef = useRef(false)
  const lastImbalanceRef = useRef<number | null>(null)
  const sweepRef = useRef(0)
  const [pulse, setPulse] = useState<DepthPulse>({
    fresh: [],
    big: null,
    imbalanceDelta: 0,
    sweepKey: 0,
  })

  const prints = data?.tape.prints
  const imbalance = data?.imbalance1pct ?? null

  useEffect(() => {
    if (!prints) return
    const seen = seenRef.current
    const fresh = prints.filter((p) => !seen.has(p.id))
    for (const p of prints) seen.add(p.id)
    if (seen.size > 600) {
      // Keep the most recent ids only — the API window is 10 minutes, so
      // anything older can never come back and be mistaken for fresh.
      seenRef.current = new Set(prints.map((p) => p.id))
    }
    // The first response is history, not news. Register it silently so the
    // panel doesn't open with a burst of stale blips.
    if (!primedRef.current) {
      primedRef.current = true
      return
    }
    if (fresh.length === 0) {
      // Clear the "just landed" highlight so a quiet poll dims the list
      // instead of leaving a minutes-old print looking brand new. `big` is
      // left alone: its blip animation already ended at opacity 0, and
      // keeping the same element avoids a pointless remount.
      setPulse((prev) => (prev.fresh.length === 0 ? prev : { ...prev, fresh: [] }))
      return
    }
    const big =
      fresh.reduce<TapePrint | null>(
        (best, p) => (best == null || p.usd > best.usd ? p : best),
        null
      ) ?? null
    setPulse((prev) => ({
      ...prev,
      fresh: fresh.slice(0, 4),
      big: big && big.usd >= BIG_PRINT_USD ? big : null,
    }))
  }, [prints])

  useEffect(() => {
    if (imbalance == null) return
    const prev = lastImbalanceRef.current
    lastImbalanceRef.current = imbalance
    if (prev == null) return
    const delta = imbalance - prev
    if (Math.abs(delta) < MOMENTUM_DELTA) return
    sweepRef.current += 1
    setPulse((p) => ({ ...p, imbalanceDelta: delta, sweepKey: sweepRef.current }))
  }, [imbalance])

  return pulse
}

// ---------- small formatters ----------------------------------------------

/** Tighter than fmtCompactUSD — one decimal, for strips where every
 *  character counts. */
function tightUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  const abs = Math.abs(n)
  const sign = n < 0 ? "-" : ""
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${sign}$${Math.round(abs / 1e3)}K`
  return `${sign}$${Math.round(abs)}`
}

function signedUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return (n > 0 ? "+" : n < 0 ? "-" : "") + tightUsd(Math.abs(n))
}

function fmtBps(n: number | null | undefined, dp = 1): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `${n.toFixed(dp)}bp`
}

function clockLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

const BID = () => paletteVar("cyph")
const ASK = () => E_STATIC.red

// ---------------------------------------------------------------------------
// DepthCurve — mirrored cumulative depth. Bids run left from the mid, asks
// run right, both plotted as cumulative USD resting inside that distance.
//
// Cumulative (rather than per-level bars) is the reading a trader actually
// wants: the height at -1% *is* "dollars of bid support within 1%", and a
// wall shows up as a visible step rather than a lone spike that needs its own
// y-scale. Wall positions are marked on the baseline instead.
// ---------------------------------------------------------------------------

function DepthCurve({
  bins,
  maxBps,
  width,
  height,
  walls = [],
  animate,
  hit,
}: {
  bins: DepthBin[]
  maxBps: number
  width: number
  height: number
  walls?: DepthWall[]
  animate: boolean
  /** `{ side, key }` — bump `key` to replay the side flash. */
  hit?: { side: "bid" | "ask"; key: number } | null
}) {
  const gradId = useId().replace(/:/g, "")
  // One flat array so both curves tween on the same clock — otherwise the
  // two halves of the chart drift out of step on a slow frame.
  const target = useMemo(
    () => [...bins.map((b) => b.bidCumUsd), ...bins.map((b) => b.askCumUsd)],
    [bins]
  )
  const live = useTweenedArray(target, animate)
  const n = bins.length

  if (n === 0) return <Skeleton height={height} />

  const bidCum = live.slice(0, n)
  const askCum = live.slice(n)
  const peak = Math.max(1, bidCum[n - 1] ?? 0, askCum[n - 1] ?? 0)
  const cx = width / 2
  const half = width / 2
  const topPad = 3
  const usable = height - topPad
  const yOf = (v: number) => topPad + usable - (v / peak) * usable
  const xOf = (i: number, side: "bid" | "ask") =>
    side === "bid"
      ? cx - ((i + 1) / n) * half
      : cx + ((i + 1) / n) * half

  const areaPath = (cum: number[], side: "bid" | "ask") => {
    const pts = cum.map((v, i) => `${xOf(i, side).toFixed(2)},${yOf(v).toFixed(2)}`)
    const endX = side === "bid" ? 0 : width
    return `M ${cx},${height} L ${cx},${yOf(0).toFixed(2)} L ${pts.join(" L ")} L ${endX},${height} Z`
  }
  const linePath = (cum: number[], side: "bid" | "ask") => {
    const pts = cum.map((v, i) => `${xOf(i, side).toFixed(2)},${yOf(v).toFixed(2)}`)
    return `M ${cx},${yOf(0).toFixed(2)} L ${pts.join(" L ")}`
  }

  const bid = BID()
  const ask = ASK()

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label="Aggregated ZEC order-book depth — bids left of mid, asks right"
      style={{ display: "block", overflow: "visible" }}
    >
      <defs>
        <linearGradient id={`bid-${gradId}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={bid} stopOpacity="0.42" />
          <stop offset="100%" stopColor={bid} stopOpacity="0.05" />
        </linearGradient>
        <linearGradient id={`ask-${gradId}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={ask} stopOpacity="0.42" />
          <stop offset="100%" stopColor={ask} stopOpacity="0.05" />
        </linearGradient>
      </defs>

      {/* ±half-range guides so the eye can read distance without labels. */}
      {[0.25, 0.5, 0.75].map((f) => (
        <g key={f}>
          <line
            x1={cx - f * half}
            y1={topPad}
            x2={cx - f * half}
            y2={height}
            stroke={paletteVar("text")}
            strokeOpacity="0.07"
            strokeWidth="1"
          />
          <line
            x1={cx + f * half}
            y1={topPad}
            x2={cx + f * half}
            y2={height}
            stroke={paletteVar("text")}
            strokeOpacity="0.07"
            strokeWidth="1"
          />
        </g>
      ))}

      <path d={areaPath(bidCum, "bid")} fill={`url(#bid-${gradId})`} />
      <path d={areaPath(askCum, "ask")} fill={`url(#ask-${gradId})`} />
      <path
        d={linePath(bidCum, "bid")}
        fill="none"
        stroke={bid}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d={linePath(askCum, "ask")}
        fill="none"
        stroke={ask}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />

      {/* Mid marker. */}
      <line
        x1={cx}
        y1={0}
        x2={cx}
        y2={height}
        stroke={paletteVar("zec")}
        strokeOpacity="0.55"
        strokeWidth="1"
        strokeDasharray="2 2"
      />

      {/* Wall ticks on the baseline — height encodes relative size so the
          biggest resting block is the tallest tick. */}
      {walls.length > 0 &&
        (() => {
          const biggest = Math.max(...walls.map((w) => w.usd), 1)
          return walls.map((w) => {
            const f = Math.min(1, w.bps / maxBps)
            const x = w.side === "bid" ? cx - f * half : cx + f * half
            const tick = 4 + (w.usd / biggest) * 7
            return (
              <line
                key={`${w.side}-${w.price}`}
                x1={x}
                y1={height}
                x2={x}
                y2={height - tick}
                stroke={w.side === "bid" ? bid : ask}
                strokeOpacity="0.9"
                strokeWidth="2"
              />
            )
          })
        })()}

      {/* Aggressive-print flash on the side that got hit. */}
      {hit && (
        <rect
          key={hit.key}
          className="cz-depth-hit"
          x={hit.side === "bid" ? 0 : cx}
          y={0}
          width={half}
          height={height}
          fill={hit.side === "bid" ? bid : ask}
          opacity="0"
        />
      )}

    </svg>
  )
}

// ---------------------------------------------------------------------------
// BullBearBar — the one-glance read. Width of the green half is the bid share
// of resting liquidity inside `bps`; the width transition is what makes the
// bar visibly breathe as the book shifts.
// ---------------------------------------------------------------------------

function BullBearBar({
  bidUsd,
  askUsd,
  height = 8,
  sweep,
  animate,
}: {
  bidUsd: number | null
  askUsd: number | null
  height?: number
  /** `{ key, dir }` — bump `key` to replay the momentum sweep. */
  sweep?: { key: number; dir: 1 | -1 } | null
  animate: boolean
}) {
  // A CSS width transition, not the rAF tween used by the curve: this is one
  // number, so letting the compositor interpolate it costs nothing and keeps
  // the bar off the React render path entirely.
  const total = (bidUsd ?? 0) + (askUsd ?? 0)
  const share = total > 0 ? (bidUsd ?? 0) / total : null
  const pct = share == null ? 50 : share * 100
  const ease = animate ? "620ms cubic-bezier(0.22, 0.7, 0.25, 1)" : "0ms"
  const bid = BID()
  const ask = ASK()
  return (
    <div
      className="relative w-full overflow-hidden"
      style={{
        height,
        background: `linear-gradient(90deg, ${withAlpha(ask, 55)} 0%, ${withAlpha(ask, 80)} 100%)`,
        border: `1px solid ${withAlpha(paletteVar("text"), 12)}`,
      }}
    >
      <div
        className="absolute inset-y-0 left-0"
        style={{
          width: `${pct}%`,
          background: `linear-gradient(90deg, ${withAlpha(bid, 80)} 0%, ${withAlpha(bid, 55)} 100%)`,
          transition: `width ${ease}`,
        }}
      />
      <div
        className="absolute inset-y-0"
        style={{
          left: `${pct}%`,
          width: 1,
          background: paletteVar("text"),
          opacity: 0.75,
          transition: `left ${ease}`,
        }}
      />
      {/* 50/50 reference tick so a lopsided book is obvious. */}
      <div
        aria-hidden="true"
        className="absolute inset-y-0 left-1/2"
        style={{ width: 1, background: paletteVar("text"), opacity: 0.2 }}
      />
      {sweep && (
        <div
          key={sweep.key}
          aria-hidden="true"
          className="cz-momentum-sweep absolute inset-y-0 w-1/3"
          style={{
            background: `linear-gradient(90deg, transparent, ${withAlpha(sweep.dir > 0 ? bid : ask, 80)}, transparent)`,
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// PrintBlip — the "someone just lifted the offer" moment. Rendered keyed on
// the trade id so each print animates exactly once and then stays put as the
// most-recent marker until the next one lands.
// ---------------------------------------------------------------------------

function PrintBlip({
  print,
  animate,
}: {
  print: TapePrint | null
  animate: boolean
}) {
  // Purely transient: the pill exists only for the ~3 s it is animating in
  // and out. With motion disabled there is no "out", so don't render it at
  // all — the print is still in the LARGE PRINTS list either way.
  if (!print || !animate) return null
  const buy = print.side === "buy"
  const c = buy ? BID() : ASK()
  return (
    <span
      key={print.id}
      className="cz-print-blip inline-flex items-center gap-1 border px-1.5 py-0 text-[9px] font-bold leading-[15px] tabular-nums whitespace-nowrap"
      style={{
        color: c,
        borderColor: withAlpha(c, 40),
        background: withAlpha(c, 10),
        textShadow: `0 0 6px ${withAlpha(c, 40)}`,
      }}
      title={`${buy ? "Aggressive buy" : "Aggressive sell"} — ${print.zec.toFixed(
        2
      )} ZEC at $${print.price.toFixed(2)} on ${print.venue} at ${clockLabel(
        print.ts
      )}`}
    >
      {buy ? "▲" : "▼"} {tightUsd(print.usd)}
    </span>
  )
}

// ---------------------------------------------------------------------------
// DepthStrip — the ZEC tile variant. Deliberately four short rows: a share
// readout, the curve, the bull/bear bar, and one line of numbers. It has to
// survive a ~300px-wide desktop tile column without wrapping, so everything
// is 9px type and the SVG scales with `preserveAspectRatio: none`.
// ---------------------------------------------------------------------------

export function DepthStrip() {
  const { data, error } = useZecDepth()
  const motion = useMotionPref()
  const animate = motion !== "off"
  const pulse = useDepthPulse(data)

  const flow = data?.tape.windows.find((w) => w.minutes === 1) ?? null
  const bid = BID()
  const ask = ASK()

  if (!data) {
    return (
      <div className="mt-3 space-y-1.5" aria-busy="true">
        {error ? (
          <div
            className="text-[9px] tracking-[0.15em]"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            DEPTH FEED UNAVAILABLE
          </div>
        ) : (
          <>
            <Skeleton height={8} />
            <Skeleton height={34} />
          </>
        )}
      </div>
    )
  }

  // Everything in the strip reads the same window the curve draws (±2%), so
  // the percentages and the picture can never disagree.
  const bidUsd = data.totals.bidUsd
  const askUsd = data.totals.askUsd
  const total = bidUsd + askUsd
  const bidPct = total > 0 ? (bidUsd / total) * 100 : null
  const bandLabel = `±${(data.maxBps / 100).toFixed(0)}%`

  return (
    <Link
      href={`/stats?view=${DEPTH_STATS_VIEW}`}
      className="relative z-[2] mt-3 block focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
      style={{ outlineColor: paletteVar("zec") }}
      title="Open the aggregated ZEC order-flow view"
    >
      <div className="flex items-center justify-between gap-1 text-[9px] font-bold tracking-[0.12em] leading-none">
        <span style={{ color: bid }}>
          BIDS {bidPct == null ? "—" : `${bidPct.toFixed(0)}%`}
        </span>
        <span className="min-w-0 truncate">
          <PrintBlip print={pulse.big} animate={animate} />
        </span>
        <span style={{ color: ask }}>
          {bidPct == null ? "—" : `${(100 - bidPct).toFixed(0)}%`} ASKS
        </span>
      </div>
      <div className="mt-1">
        <DepthCurve
          bins={data.bins}
          maxBps={data.maxBps}
          width={300}
          height={34}
          walls={data.walls}
          animate={animate}
          hit={
            animate && pulse.big
              ? {
                  side: pulse.big.side === "buy" ? "ask" : "bid",
                  key: pulse.big.ts,
                }
              : null
          }
        />
      </div>
      <div className="mt-0.5">
        <BullBearBar
          bidUsd={bidUsd}
          askUsd={askUsd}
          height={5}
          animate={animate}
          sweep={
            animate && pulse.sweepKey > 0
              ? {
                  key: pulse.sweepKey,
                  dir: pulse.imbalanceDelta >= 0 ? 1 : -1,
                }
              : null
          }
        />
      </div>
      <div
        className="mt-1 flex items-center justify-between gap-1 text-[9px] tabular-nums leading-none"
        style={{ color: paletteVar("text"), opacity: 0.75 }}
      >
        <span>SPR {fmtBps(data.spreadBps, 2)}</span>
        <span>
          {bandLabel} {tightUsd(total)}
        </span>
        <span
          style={{
            color:
              flow?.deltaUsd == null
                ? paletteVar("text")
                : flow.deltaUsd >= 0
                  ? bid
                  : ask,
            opacity: 1,
          }}
        >
          1M {signedUsd(flow?.deltaUsd ?? null)}
        </span>
      </div>
    </Link>
  )
}

// ---------- shared panel pieces -------------------------------------------

function StatCell({
  label,
  children,
  color,
  tip,
}: {
  label: string
  children: React.ReactNode
  color?: string
  tip?: React.ReactNode
}) {
  return (
    <div
      className="px-2 py-1.5"
      style={{ background: withAlpha(paletteVar("text"), 3) }}
    >
      <div
        className="flex items-center gap-1 text-[9px] tracking-[0.16em] leading-none"
        style={{ color: paletteVar("text"), opacity: 0.65 }}
      >
        <span>{label}</span>
        {tip && (
          <InfoTip label={label} align="center">
            {tip}
          </InfoTip>
        )}
      </div>
      <div
        className="mt-1 text-[13px] font-bold tabular-nums leading-tight"
        style={{ color: color ?? paletteVar("text") }}
      >
        {children}
      </div>
    </div>
  )
}

/** Header chip: N of M venue books currently contributing. */
function VenueChip({ data }: { data: ZecDepthResponse }) {
  const down = data.venues.filter((v) => !v.ok)
  const c = down.length === 0 ? paletteVar("cyph") : paletteVar("amber")
  return (
    <span
      className="inline-flex items-center gap-1 border px-1.5 text-[9px] font-bold leading-[16px] tracking-[0.1em]"
      style={{ color: c, borderColor: withAlpha(c, 33) }}
      title={
        down.length === 0
          ? `All ${data.venuesTotal} venue books responded`
          : `Not contributing: ${down
              .map((v) => `${v.name} (${v.error ?? "no data"})`)
              .join(", ")}`
      }
    >
      {data.venuesOk}/{data.venuesTotal} VENUES
    </span>
  )
}

/** Cumulative-delta sparkline for the last 15 minutes of tape. */
function CvdSpark({
  points,
  width = 220,
  height = 30,
}: {
  points: { ts: number; cum: number }[]
  width?: number
  height?: number
}) {
  if (points.length < 2) return <Skeleton height={height} />
  const values = points.map((p) => p.cum)
  const max = Math.max(...values, 0)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const yOf = (v: number) => height - ((v - min) / span) * height
  const d = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * width).toFixed(2)},${yOf(v).toFixed(2)}`
    )
    .join(" L ")
  const last = values[values.length - 1]
  const c = last >= 0 ? BID() : ASK()
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label="Cumulative volume delta, last 15 minutes"
      style={{ display: "block" }}
    >
      <line
        x1="0"
        y1={yOf(0)}
        x2={width}
        y2={yOf(0)}
        stroke={paletteVar("text")}
        strokeOpacity="0.2"
        strokeDasharray="2 3"
      />
      <path
        d={`M 0,${yOf(0).toFixed(2)} L ${d} L ${width},${yOf(0).toFixed(2)} Z`}
        fill={c}
        fillOpacity="0.14"
      />
      <path d={`M ${d}`} fill="none" stroke={c} strokeWidth="1.5" />
    </svg>
  )
}

/** Buy / sell pressure for one tape window. */
function PressureRow({
  window: w,
}: {
  window: ZecDepthResponse["tape"]["windows"][number]
}) {
  const bid = BID()
  const ask = ASK()
  const pct = w.pressure == null ? null : w.pressure * 100
  // Complete only when EVERY live tape venue reached back the whole window.
  // `w.venues` is the set that was summed, which in the partial case is a
  // subset — so comparing against it would call a Kraken-only 15m total
  // complete while Coinbase and OKX flow is missing from it.
  const complete = w.venuesLive > 0 && w.covered === w.venuesLive
  return (
    <div className="grid grid-cols-[34px_1fr_66px] items-center gap-2">
      <span
        className="text-[10px] tracking-[0.12em]"
        style={{ color: paletteVar("text"), opacity: 0.7 }}
        title={
          complete
            ? `${w.venues.join(", ")} · ${w.trades.toLocaleString()} trades`
            : w.covered === 0
              ? `No venue had the full ${w.minutes}m of trade history in this fetch — summed whatever ${w.venues.join(
                  ", "
                )} did return, so this under-states real flow`
              : `Counted ${w.venues.join(", ")} — ${w.covered} of ${
                  w.venuesLive
                } venues had the full ${w.minutes}m of history, so this under-states real flow`
        }
      >
        {w.minutes}M{complete ? "" : "*"}
      </span>
      <div
        className="relative h-[6px] overflow-hidden"
        style={{ background: withAlpha(ask, 15), border: `1px solid ${withAlpha(paletteVar("text"), 10)}` }}
      >
        <div
          className="absolute inset-y-0 left-0"
          style={{
            width: `${pct ?? 50}%`,
            background: bid,
            opacity: 0.75,
            transition: "width 620ms cubic-bezier(0.22, 0.7, 0.25, 1)",
          }}
        />
      </div>
      <span
        className="text-right text-[10px] font-bold tabular-nums"
        style={{ color: w.deltaUsd >= 0 ? bid : ask }}
      >
        {signedUsd(w.deltaUsd)}
      </span>
    </div>
  )
}

/** Resting blocks worth calling out, biggest first. */
function WallRow({ wall, mid }: { wall: DepthWall; mid: number | null }) {
  const c = wall.side === "bid" ? BID() : ASK()
  const away =
    mid != null && mid > 0 ? ((wall.price - mid) / mid) * 100 : null
  return (
    <div
      className="grid grid-cols-[16px_1fr_58px_46px] items-center gap-1.5 px-1.5 py-1 text-[10px] tabular-nums"
      style={{ background: withAlpha(c, 6) }}
      title={`${wall.zec.toLocaleString("en-US", {
        maximumFractionDigits: 0,
      })} ZEC resting around $${wall.price.toFixed(2)} across ${
        wall.venues
      } venue${wall.venues === 1 ? "" : "s"}`}
    >
      <span style={{ color: c }}>{wall.side === "bid" ? "▲" : "▼"}</span>
      <span style={{ color: c }} className="font-bold">
        ${wall.price.toFixed(2)}
      </span>
      <span className="text-right font-bold" style={{ color: c }}>
        {tightUsd(wall.usd)}
      </span>
      <span
        className="text-right"
        style={{ color: paletteVar("text"), opacity: 0.65 }}
      >
        {away == null ? "—" : `${away >= 0 ? "+" : ""}${away.toFixed(2)}%`}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel building blocks — shared by the dashboard section and the /stats view.
// ---------------------------------------------------------------------------

function imbalanceLabel(v: number | null): string {
  if (v == null) return "—"
  const pct = Math.abs(v) * 100
  if (pct < 3) return "BALANCED"
  return v > 0 ? "BID-HEAVY" : "ASK-HEAVY"
}

function DepthHeadline({ data }: { data: ZecDepthResponse }) {
  const bid = BID()
  const ask = ASK()
  const l1 = data.ladder.find((r) => r.bps === 100)
  const imb = data.imbalance1pct
  const imbColor =
    imb == null
      ? paletteVar("text")
      : Math.abs(imb) < 0.03
        ? paletteVar("text")
        : imb > 0
          ? bid
          : ask
  return (
    <div
      className="grid grid-cols-2 md:grid-cols-4 gap-px"
      style={{ border: `1px solid ${withAlpha(paletteVar("zec"), 17)}` }}
    >
      <StatCell
        label="MID"
        color={paletteVar("zec")}
        tip={
          <>
            Depth-weighted mid across the USD-quoted books (Kraken, Coinbase).
            USDT venues are folded in for depth but never set the headline
            price, so this stays a dollar number.
          </>
        }
      >
        <LiveNumber
          value={data.mid}
          format={(v) => "$" + v.toFixed(2)}
          color={paletteVar("zec")}
        />
      </StatCell>
      <StatCell
        label="AGG SPREAD"
        tip={
          <>
            Best bid {data.bestBid != null && <>(${data.bestBid.toFixed(2)}) </>}
            against best ask{" "}
            {data.bestAsk != null && <>(${data.bestAsk.toFixed(2)}) </>}
            across every venue, after each book is mid-aligned. It is tighter
            than any single venue&apos;s spread by construction — that is the
            cross-venue arbitrage window, not a spread you can trade on one
            exchange. Per-venue spreads are in the VENUES table.
          </>
        }
      >
        {fmtBps(data.spreadBps, 2)}
      </StatCell>
      <StatCell
        label="DEPTH ±1%"
        tip={
          <>
            Resting notional within 1% of the mid, both sides added together.
            The single best proxy for how much size this market can absorb
            without the price running away.
          </>
        }
      >
        {fmtCompactUSD((l1?.bidUsd ?? 0) + (l1?.askUsd ?? 0))}
      </StatCell>
      <StatCell
        label="IMBALANCE ±1%"
        color={imbColor}
        tip={
          <>
            (bids − asks) ÷ (bids + asks) within 1% of mid. Positive means
            more dollars are waiting to buy than to sell inside that band.
            It is a snapshot of resting intent, not a forecast — walls get
            pulled.
          </>
        }
      >
        {imb == null ? "—" : `${imb > 0 ? "+" : ""}${(imb * 100).toFixed(1)}%`}
        <span
          className="ml-1.5 text-[9px] font-normal tracking-[0.1em]"
          style={{ opacity: 0.7 }}
        >
          {imbalanceLabel(imb)}
        </span>
      </StatCell>
    </div>
  )
}

function DepthCoreChart({
  data,
  pulse,
  animate,
  height,
  width,
}: {
  data: ZecDepthResponse
  pulse: DepthPulse
  animate: boolean
  height: number
  width: number
}) {
  const bid = BID()
  const ask = ASK()
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[10px] tracking-[0.14em] leading-none">
        <span style={{ color: bid }}>
          BIDS {tightUsd(data.totals.bidUsd)}
        </span>
        <span
          className="tabular-nums"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          CUMULATIVE ±{(data.maxBps / 100).toFixed(0)}%
        </span>
        <span style={{ color: ask }}>
          {tightUsd(data.totals.askUsd)} ASKS
        </span>
      </div>
      <div className="mt-1.5">
        <DepthCurve
          bins={data.bins}
          maxBps={data.maxBps}
          width={width}
          height={height}
          walls={data.walls}
          animate={animate}
          hit={
            animate && pulse.big
              ? {
                  side: pulse.big.side === "buy" ? "ask" : "bid",
                  key: pulse.big.ts,
                }
              : null
          }
        />
      </div>
      <div className="mt-1.5">
        <BullBearBar
          bidUsd={data.totals.bidUsd}
          askUsd={data.totals.askUsd}
          height={9}
          animate={animate}
          sweep={
            animate && pulse.sweepKey > 0
              ? { key: pulse.sweepKey, dir: pulse.imbalanceDelta >= 0 ? 1 : -1 }
              : null
          }
        />
      </div>
      {/* Axis in HTML, not inside the SVG: the chart scales with
          `preserveAspectRatio: none`, which would stretch SVG glyphs
          horizontally by however much the container exceeds the viewBox. */}
      <div
        className="mt-1 flex items-center justify-between text-[9px] tabular-nums tracking-[0.1em]"
        style={{ color: paletteVar("text"), opacity: 0.55 }}
      >
        <span>-{(data.maxBps / 100).toFixed(0)}%</span>
        <span style={{ color: paletteVar("zec"), opacity: 0.85 }}>
          {data.mid == null ? "MID" : `$${data.mid.toFixed(2)}`}
        </span>
        <span>+{(data.maxBps / 100).toFixed(0)}%</span>
      </div>
    </div>
  )
}

/** Bid vs ask notional at each distance band, with a shared-scale bar pair
 *  so the side that dominates is obvious without reading the numbers. */
function LadderTable({ data }: { data: ZecDepthResponse }) {
  const bid = BID()
  const ask = ASK()
  const peak = Math.max(
    1,
    ...data.ladder.flatMap((r) => [r.bidUsd, r.askUsd])
  )
  return (
    <div>
      <div
        className="grid grid-cols-[52px_1fr_1fr] gap-2 pb-1 text-[9px] tracking-[0.16em]"
        style={{ color: paletteVar("text"), opacity: 0.6 }}
      >
        <span>BAND</span>
        {/* Left-aligned to sit over the bid figures, which live on the outer
            edge so the two sides mirror around the mid. */}
        <span>BIDS</span>
        <span className="text-right">ASKS</span>
      </div>
      <div className="space-y-1">
        {data.ladder.map((row) => (
          <div
            key={row.bps}
            className="grid grid-cols-[52px_1fr_1fr] items-center gap-2 text-[10px] tabular-nums"
            title={`Within ±${
              row.bps >= 100 ? `${row.bps / 100}%` : `${row.bps}bp`
            } of mid: ${row.bidZec.toLocaleString("en-US", {
              maximumFractionDigits: 0,
            })} ZEC bid, ${row.askZec.toLocaleString("en-US", {
              maximumFractionDigits: 0,
            })} ZEC offered`}
          >
            <span style={{ color: paletteVar("text"), opacity: 0.8 }}>
              ±{row.bps >= 100 ? `${row.bps / 100}%` : `${row.bps}bp`}
            </span>
            {/* Bid bar grows right-to-left so both sides mirror the chart. */}
            <span className="relative flex h-[15px] items-center justify-start overflow-hidden">
              <span
                aria-hidden="true"
                className="absolute inset-y-0 right-0"
                style={{
                  width: `${(row.bidUsd / peak) * 100}%`,
                  background: withAlpha(bid, 18),
                  transition: "width 620ms cubic-bezier(0.22,0.7,0.25,1)",
                }}
              />
              <span className="relative pl-1 font-bold" style={{ color: bid }}>
                {tightUsd(row.bidUsd)}
              </span>
            </span>
            <span className="relative flex h-[15px] items-center justify-end overflow-hidden">
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0"
                style={{
                  width: `${(row.askUsd / peak) * 100}%`,
                  background: withAlpha(ask, 18),
                  transition: "width 620ms cubic-bezier(0.22,0.7,0.25,1)",
                }}
              />
              <span className="relative pr-1 font-bold" style={{ color: ask }}>
                {tightUsd(row.askUsd)}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** What a market order of size N would actually cost, walked through the
 *  aggregated book. The honest version of "how liquid is ZEC". */
function ImpactTable({ data }: { data: ZecDepthResponse }) {
  const bid = BID()
  const ask = ASK()
  return (
    <div>
      <div
        className="grid grid-cols-[1fr_66px_66px] gap-2 pb-1 text-[9px] tracking-[0.16em]"
        style={{ color: paletteVar("text"), opacity: 0.6 }}
      >
        <span>ORDER</span>
        <span className="text-right">BUY</span>
        <span className="text-right">SELL</span>
      </div>
      <div className="space-y-1">
        {data.impact.map((row) => (
          <div
            key={row.usd}
            className="grid grid-cols-[1fr_66px_66px] items-center gap-2 text-[10px] tabular-nums"
          >
            <span style={{ color: paletteVar("text"), opacity: 0.8 }}>
              {tightUsd(row.usd)}
            </span>
            <span
              className="text-right font-bold"
              style={{ color: row.buyBps == null ? paletteVar("text") : ask }}
              title={
                row.buyPrice != null
                  ? `Average fill $${row.buyPrice.toFixed(2)}`
                  : "Larger than the aggregated book can fill"
              }
            >
              {row.buyBps == null ? "n/a" : `+${row.buyBps.toFixed(1)}bp`}
            </span>
            <span
              className="text-right font-bold"
              style={{ color: row.sellBps == null ? paletteVar("text") : bid }}
              title={
                row.sellPrice != null
                  ? `Average fill $${row.sellPrice.toFixed(2)}`
                  : "Larger than the aggregated book can fill"
              }
            >
              {row.sellBps == null ? "n/a" : `-${row.sellBps.toFixed(1)}bp`}
            </span>
          </div>
        ))}
      </div>
      <div
        className="mt-1.5 text-[9px] leading-snug"
        style={{ color: paletteVar("text"), opacity: 0.5 }}
      >
        Slippage vs mid, walked through the aggregated book out to ±
        {(data.impactMaxBps / 100).toFixed(0)}%. &quot;n/a&quot; means even
        that much book can&apos;t absorb the size.
      </div>
    </div>
  )
}

function TapeBlock({
  data,
  pulse,
  animate,
  sparkWidth = 220,
}: {
  data: ZecDepthResponse
  pulse: DepthPulse
  animate: boolean
  sparkWidth?: number
}) {
  const bid = BID()
  const ask = ASK()
  const cvdLast = data.tape.cvd.at(-1)?.cum ?? null
  const cvdFirstTs = data.tape.cvd[0]?.ts
  const cvdLastTs = data.tape.cvd.at(-1)?.ts
  const cvdSpan =
    cvdFirstTs != null && cvdLastTs != null
      ? {
          from: clockLabel(cvdFirstTs).slice(0, 5),
          to: clockLabel(cvdLastTs).slice(0, 5),
        }
      : null
  const partial = data.tape.windows.some(
    (w) => w.venuesLive === 0 || w.covered !== w.venuesLive
  )
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-[9px] tracking-[0.16em]"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          TAKER PRESSURE
        </span>
        <span className="min-w-0 truncate text-right">
          <PrintBlip print={pulse.big} animate={animate} />
        </span>
      </div>
      <div className="space-y-1.5">
        {data.tape.windows.map((w) => (
          <PressureRow key={w.minutes} window={w} />
        ))}
      </div>
      {partial && (
        <div
          className="text-[9px] leading-snug"
          style={{ color: paletteVar("text"), opacity: 0.45 }}
        >
          * one or more venues did not have the full window of trade history
          in this fetch, so that total under-states the real flow — hover the
          label for the detail.
        </div>
      )}
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span
            className="text-[9px] tracking-[0.16em]"
            style={{ color: paletteVar("text"), opacity: 0.6 }}
            title={
              cvdSpan
                ? `Cumulative taker delta, ${cvdSpan.from} to ${cvdSpan.to}`
                : undefined
            }
          >
            CVD{cvdSpan ? ` · ${cvdSpan.from}-${cvdSpan.to}` : ""}
          </span>
          <span
            className="text-[10px] font-bold tabular-nums"
            style={{ color: (cvdLast ?? 0) >= 0 ? bid : ask }}
          >
            {signedUsd(cvdLast)}
          </span>
        </div>
        <div className="mt-1">
          <CvdSpark points={data.tape.cvd} width={sparkWidth} />
        </div>
      </div>
      <div>
        <div
          className="pb-1 text-[9px] tracking-[0.16em]"
          style={{ color: paletteVar("text"), opacity: 0.6 }}
        >
          LARGE PRINTS
        </div>
        {data.tape.prints.length === 0 ? (
          <div
            className="text-[10px]"
            style={{ color: paletteVar("text"), opacity: 0.45 }}
          >
            No prints over {tightUsd(data.tape.minPrintUsd)} in the last{" "}
            {data.tape.printWindowMinutes} minutes.
          </div>
        ) : (
          <div className="space-y-px">
            {data.tape.prints.slice(0, 6).map((p) => {
              const c = p.side === "buy" ? bid : ask
              const isNew = pulse.fresh.some((f) => f.id === p.id)
              return (
                <div
                  key={p.id}
                  className={`grid grid-cols-[14px_1fr_58px_54px] items-center gap-1.5 px-1.5 py-[3px] text-[10px] tabular-nums ${
                    isNew ? "cz-fade-in" : ""
                  }`}
                  style={{ background: withAlpha(c, isNew ? 12 : 5) }}
                  title={`${p.zec.toFixed(4)} ZEC at $${p.price.toFixed(2)} on ${
                    p.venue
                  }`}
                >
                  <span style={{ color: c }}>
                    {p.side === "buy" ? "▲" : "▼"}
                  </span>
                  <span
                    className="truncate"
                    style={{ color: paletteVar("text"), opacity: 0.75 }}
                  >
                    {p.venue}
                  </span>
                  <span
                    className="text-right font-bold"
                    style={{ color: c }}
                  >
                    {tightUsd(p.usd)}
                  </span>
                  <span
                    className="text-right"
                    style={{ color: paletteVar("text"), opacity: 0.55 }}
                  >
                    {clockLabel(p.ts).slice(0, 5)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function VenueTable({ data }: { data: ZecDepthResponse }) {
  const bid = BID()
  return (
    <div>
      <div
        className="grid grid-cols-[1fr_54px_58px_46px] gap-2 pb-1 text-[9px] tracking-[0.16em]"
        style={{ color: paletteVar("text"), opacity: 0.6 }}
      >
        <span>VENUE</span>
        <span className="text-right">SPREAD</span>
        <span className="text-right">±1%</span>
        <span className="text-right">BASIS</span>
      </div>
      <div className="space-y-px">
        {data.venues.map((v) => (
          <div
            key={v.id}
            className="grid grid-cols-[1fr_54px_58px_46px] items-center gap-2 px-1.5 py-1 text-[10px] tabular-nums"
            style={{
              background: v.ok
                ? `linear-gradient(to right, ${withAlpha(bid, 9)} 0%, ${withAlpha(bid, 9)} ${(
                    v.share * 100
                  ).toFixed(1)}%, transparent ${(v.share * 100).toFixed(
                    1
                  )}%, transparent 100%)`
                : "transparent",
              opacity: v.ok ? 1 : 0.4,
            }}
            title={
              v.ok
                ? `${v.pair} · ${v.levels.toLocaleString()} levels · ${(
                    v.share * 100
                  ).toFixed(1)}% of aggregate ±1% depth`
                : `${v.pair} · unavailable: ${v.error ?? "no data"}`
            }
          >
            <span className="truncate font-bold" style={{ color: paletteVar("zec") }}>
              {v.name}
            </span>
            <span className="text-right" style={{ color: paletteVar("text") }}>
              {v.ok ? fmtBps(v.spreadBps) : "—"}
            </span>
            <span className="text-right font-bold" style={{ color: paletteVar("text") }}>
              {v.ok ? tightUsd(v.depthUsd) : "OFF"}
            </span>
            <span
              className="text-right"
              style={{ color: paletteVar("text"), opacity: 0.65 }}
            >
              {v.ok && v.basisBps != null
                ? `${v.basisBps >= 0 ? "+" : ""}${v.basisBps.toFixed(1)}`
                : "—"}
            </span>
          </div>
        ))}
      </div>
      <div
        className="mt-1.5 text-[9px] leading-snug"
        style={{ color: paletteVar("text"), opacity: 0.5 }}
      >
        BASIS is each venue&apos;s mid against the consensus mid, in bps. Books
        are mid-aligned before they are added together, so a venue trading rich
        doesn&apos;t contribute phantom liquidity on the wrong side.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Price action — the analytical half of the ORDER FLOW view.
//
// Deliberately *not* what the markets/exchanges surfaces already show (venue
// volume, rankings, market cap). Everything here is about how the price is
// behaving: where it sits in its own range, what it costs in volatility, and
// whether the last few hours agree with the last few days.
//
// Intraday numbers come from the depth endpoint's Kraken candles; the daily
// ones are computed here from the /api/prices history the host page already
// has, so this panel adds no extra request.
// ---------------------------------------------------------------------------

/** Wilder's RSI over daily closes. Null until there are enough points. */
function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

/** Annualized stdev of daily log returns, in percent. */
function dailyVol(closes: number[]): number | null {
  if (closes.length < 10) return null
  const rets: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      rets.push(Math.log(closes[i] / closes[i - 1]))
    }
  }
  if (rets.length < 8) return null
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length
  const variance =
    rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)
  return Math.sqrt(variance) * Math.sqrt(365) * 100
}

interface DailyStats {
  rsi14: number | null
  vol30d: number | null
  high90d: number | null
  low90d: number | null
  drawdownPct: number | null
}

function computeDaily(history: PricesHistoryPoint[] | undefined): DailyStats {
  const closes = (history ?? [])
    .map((p) => p.zec)
    .filter((v): v is number => typeof v === "number" && v > 0)
  if (closes.length === 0) {
    return {
      rsi14: null,
      vol30d: null,
      high90d: null,
      low90d: null,
      drawdownPct: null,
    }
  }
  const last = closes[closes.length - 1]
  const window = closes.slice(-90)
  const high = Math.max(...window)
  const low = Math.min(...window)
  return {
    rsi14: rsi(closes.slice(-60)),
    vol30d: dailyVol(closes.slice(-31)),
    high90d: high,
    low90d: low,
    drawdownPct: high > 0 ? ((last - high) / high) * 100 : null,
  }
}

/** Where price sits between two bounds, drawn as a marker on a track. */
function RangeGauge({
  label,
  low,
  high,
  value,
  color,
  note,
}: {
  label: string
  low: number | null
  high: number | null
  value: number | null
  color: string
  /** Small trailing caption under the track, e.g. how wide the range is. */
  note?: string
}) {
  const pos =
    low != null && high != null && value != null && high > low
      ? Math.min(1, Math.max(0, (value - low) / (high - low)))
      : null
  return (
    <div>
      <div
        className="flex items-baseline justify-between text-[9px] tracking-[0.14em]"
        style={{ color: paletteVar("text"), opacity: 0.65 }}
      >
        <span>{label}</span>
        <span className="tabular-nums">
          {pos == null ? "—" : `${(pos * 100).toFixed(0)}% OF RANGE`}
        </span>
      </div>
      <div
        className="relative mt-1 h-[7px]"
        style={{
          background: `linear-gradient(90deg, ${withAlpha(ASK(), 20)}, ${withAlpha(paletteVar("text"), 10)}, ${withAlpha(BID(), 20)})`,
          border: `1px solid ${withAlpha(paletteVar("text"), 12)}`,
        }}
      >
        {pos != null && (
          <span
            className="absolute top-[-2px] h-[11px] w-[2px]"
            style={{
              left: `calc(${(pos * 100).toFixed(2)}% - 1px)`,
              background: color,
              boxShadow: `0 0 6px ${color}`,
              transition: "left 620ms cubic-bezier(0.22,0.7,0.25,1)",
            }}
          />
        )}
      </div>
      <div
        className="mt-0.5 flex items-baseline justify-between gap-2 text-[9px] tabular-nums"
        style={{ color: paletteVar("text"), opacity: 0.5 }}
      >
        <span>{low == null ? "—" : `$${low.toFixed(2)}`}</span>
        {note && <span className="truncate">{note}</span>}
        <span>{high == null ? "—" : `$${high.toFixed(2)}`}</span>
      </div>
    </div>
  )
}

/** 24h of 5-minute closes with the session VWAP as a reference line. */
function IntradayChart({
  candles,
  vwap,
  width = 420,
  height = 64,
}: {
  candles: DepthMicroStats["candles"]
  vwap: number | null
  width?: number
  height?: number
}) {
  const closes = candles?.closes ?? []
  if (closes.length < 3 || !candles) return <Skeleton height={height} />
  const values = vwap != null ? [...closes, vwap] : closes
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const yOf = (v: number) => 2 + (height - 4) * (1 - (v - min) / span)
  const pts = closes
    .map(
      (v, i) =>
        `${((i / (closes.length - 1)) * width).toFixed(2)},${yOf(v).toFixed(2)}`
    )
    .join(" L ")
  const up = closes[closes.length - 1] >= closes[0]
  const c = up ? BID() : ASK()
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label="ZEC price, last 24 hours in 5-minute closes"
      style={{ display: "block" }}
    >
      {vwap != null && (
        <line
          x1="0"
          y1={yOf(vwap)}
          x2={width}
          y2={yOf(vwap)}
          stroke={paletteVar("amber")}
          strokeOpacity="0.65"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
      )}
      <path
        d={`M 0,${height} L ${pts} L ${width},${height} Z`}
        fill={c}
        fillOpacity="0.12"
      />
      <path d={`M ${pts}`} fill="none" stroke={c} strokeWidth="1.5" />
    </svg>
  )
}

/** Time axis for the intraday series. In HTML, not inside the SVG, because
 *  the chart scales with `preserveAspectRatio: none`. */
function IntradayAxis({
  candles,
  vwap,
}: {
  candles: DepthMicroStats["candles"]
  vwap: number | null
}) {
  if (!candles) return null
  // Relative end labels, not clock times: the window is exactly 24h, so both
  // ends land on nearly the same wall-clock reading and "14:20 … 14:15" looks
  // like a mistake. The exact span lives in the tooltip.
  return (
    <div
      className="mt-1 flex items-baseline justify-between gap-2 text-[9px] tabular-nums"
      style={{ color: paletteVar("text"), opacity: 0.55 }}
      title={`5-minute closes from ${new Date(
        candles.startTs
      ).toLocaleString()} to ${new Date(candles.endTs).toLocaleString()}`}
    >
      <span>-24H</span>
      <span style={{ color: paletteVar("amber"), opacity: 0.85 }}>
        {vwap == null ? "VWAP" : `VWAP $${vwap.toFixed(2)}`}
      </span>
      <span>{clockLabel(candles.endTs).slice(0, 5)}</span>
    </div>
  )
}

function TrendLadder({ trend }: { trend: NonNullable<ZecDepthResponse["micro"]>["trend"] }) {
  const cells: [string, number | null][] = [
    ["5M", trend.m5],
    ["15M", trend.m15],
    ["1H", trend.h1],
    ["4H", trend.h4],
    ["24H", trend.h24],
  ]
  return (
    <div className="grid grid-cols-5 gap-px">
      {cells.map(([label, v]) => {
        const flat = v != null && Math.abs(v) < 0.005
        const c =
          v == null || flat ? paletteVar("text") : v > 0 ? BID() : ASK()
        return (
          <div
            key={label}
            className="px-1 py-1 text-center"
            style={{ background: v == null || flat ? "transparent" : withAlpha(c, 7) }}
          >
            <div
              className="text-[9px] tracking-[0.1em]"
              style={{ color: paletteVar("text"), opacity: 0.6 }}
            >
              {label}
            </div>
            <div
              className="text-[10px] font-bold tabular-nums"
              style={{ color: c, opacity: v == null ? 0.5 : 1 }}
            >
              {v == null ? "—" : fmtPct(v)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function PriceActionBlock({
  data,
  history,
  chartWidth = 420,
}: {
  data: ZecDepthResponse
  history?: PricesHistoryPoint[]
  chartWidth?: number
}) {
  const micro = data.micro
  const daily = useMemo(() => computeDaily(history), [history])
  const zec = paletteVar("zec")

  if (!micro) {
    return (
      <div
        className="text-[11px]"
        style={{ color: paletteVar("text"), opacity: 0.5 }}
      >
        Intraday candles unavailable right now.
      </div>
    )
  }

  const rsiColor =
    daily.rsi14 == null
      ? paletteVar("text")
      : daily.rsi14 >= 70
        ? ASK()
        : daily.rsi14 <= 30
          ? BID()
          : paletteVar("text")

  return (
    <div className="space-y-3">
      <div>
        <IntradayChart
          candles={micro.candles}
          vwap={micro.vwap24h}
          width={chartWidth}
        />
        <IntradayAxis candles={micro.candles} vwap={micro.vwap24h} />
      </div>
      <TrendLadder trend={micro.trend} />
      <RangeGauge
        label="24H RANGE"
        low={micro.low24h}
        high={micro.high24h}
        value={micro.price}
        color={zec}
        note={
          micro.rangePct24h == null
            ? undefined
            : `${micro.rangePct24h.toFixed(1)}% WIDE`
        }
      />
      <div className="grid grid-cols-2 md:grid-cols-3 gap-px">
        <StatCell
          label="VWAP 24H"
          tip={
            <>
              Volume-weighted average price over the last 24h of Kraken
              candles, and how far spot sits above or below it. Trading above
              VWAP means today&apos;s buyers are, on average, in profit.
            </>
          }
        >
          {micro.vwap24h == null ? "—" : `$${micro.vwap24h.toFixed(2)}`}
          {micro.vwapPremiumBps != null && (
            <span
              className="ml-1.5 text-[9px] font-normal"
              style={{
                color: micro.vwapPremiumBps >= 0 ? BID() : ASK(),
              }}
            >
              {micro.vwapPremiumBps >= 0 ? "+" : ""}
              {(micro.vwapPremiumBps / 100).toFixed(2)}%
            </span>
          )}
        </StatCell>
        <StatCell
          label="RV 24H"
          tip={
            <>
              Realized volatility — the annualized standard deviation of
              5-minute log returns over the last 24h. Compare it against the
              7D and 30D figures to see whether the market is heating up or
              cooling off.
            </>
          }
        >
          {micro.vol24hPct == null ? "—" : `${micro.vol24hPct.toFixed(0)}%`}
        </StatCell>
        <StatCell label="RV 7D / 30D">
          {micro.vol7dPct == null ? "—" : `${micro.vol7dPct.toFixed(0)}%`}
          <span className="opacity-50"> / </span>
          {micro.vol30dPct == null ? "—" : `${micro.vol30dPct.toFixed(0)}%`}
        </StatCell>
        <StatCell
          label="ATR 24H"
          tip={
            <>
              Average true range of the 5-minute bars over the last 24h, as a
              percentage of price — roughly how far ZEC travels in a typical
              five minutes.
            </>
          }
        >
          {micro.atr24hPct == null ? "—" : `${micro.atr24hPct.toFixed(2)}%`}
        </StatCell>
        <StatCell
          label="RSI 14D"
          color={rsiColor}
          tip={
            <>
              Wilder&apos;s RSI on daily closes. Above 70 is conventionally
              read as overbought, below 30 as oversold. Computed from the same
              daily history the price chart uses.
            </>
          }
        >
          {daily.rsi14 == null ? "—" : daily.rsi14.toFixed(1)}
        </StatCell>
        <StatCell
          label="FROM 90D HIGH"
          tip={
            <>
              Distance from the highest daily close in the last 90 days —
              the drawdown a holder who bought the local top is sitting in.
            </>
          }
        >
          {daily.drawdownPct == null
            ? "—"
            : `${daily.drawdownPct.toFixed(1)}%`}
        </StatCell>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-6">
        <RangeGauge
          label="7D RANGE"
          low={micro.low7d}
          high={micro.high7d}
          value={micro.price}
          color={zec}
        />
        <RangeGauge
          label="30D RANGE"
          low={micro.low30d}
          high={micro.high30d}
          value={micro.price}
          color={zec}
        />
      </div>
      <div
        className="text-[9px] leading-snug"
        style={{ color: paletteVar("text"), opacity: 0.5 }}
      >
        Intraday figures from Kraken ZEC/USD candles (5m and 1h); RSI and the
        90-day drawdown from the same daily history as the price charts.
        {micro.volumeZec24h != null && (
          <>
            {" "}
            Kraken 24h volume{" "}
            {micro.volumeZec24h.toLocaleString("en-US", {
              maximumFractionDigits: 0,
            })}{" "}
            ZEC.
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Exported surfaces
// ---------------------------------------------------------------------------

/** Small "updated Ns ago" / stale marker shared by both panels. */
function FeedFooter({ data }: { data: ZecDepthResponse }) {
  const visible = usePageVisible()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [visible])
  const age = Math.max(0, Math.round((now - data.fetchedAt) / 1000))
  // Polling stops while the tab is backgrounded, so a growing age is normal
  // and should not keep claiming LIVE. 30 s is comfortably past the 6 s poll
  // plus the route's 5 s server cache.
  const idle = data.stale || age > 30
  const c = idle ? paletteVar("amber") : paletteVar("cyph")
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[9px] tracking-[0.12em] tabular-nums"
      style={{ color: paletteVar("text"), opacity: 0.6 }}
    >
      <span
        aria-hidden="true"
        className={idle ? "" : "cz-depth-live"}
        style={{
          width: 5,
          height: 5,
          borderRadius: 999,
          background: c,
          boxShadow: `0 0 6px ${c}`,
        }}
      />
      {data.stale ? "CACHED" : idle ? "PAUSED" : "LIVE"} · {age}s
    </span>
  )
}

/**
 * Full-width dashboard section. This is the answer to "the tile is too narrow
 * on desktop" — same feed, but with room for the tape, the walls and real
 * axis labels. Hidden by default; the header's own toggle writes the same
 * setting the Settings page does.
 */
export function DepthSection({ onHide }: { onHide: () => void }) {
  const { data, error } = useZecDepth()
  const motion = useMotionPref()
  const animate = motion !== "off"
  const pulse = useDepthPulse(data)

  return (
    <CornerBox
      label="ORDER FLOW · AGGREGATED DEPTH"
      color={paletteVar("zec")}
      action={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {data && <VenueChip data={data} />}
          {data && <FeedFooter data={data} />}
          <Link
            href={`/stats?view=${DEPTH_STATS_VIEW}`}
            className="border px-1.5 text-[9px] font-bold leading-[16px] tracking-[0.1em] transition-colors hover:bg-white/5"
            style={{
              color: paletteVar("zec"),
              borderColor: withAlpha(paletteVar("zec"), 33),
            }}
          >
            FULL VIEW -&gt;
          </Link>
          <button
            type="button"
            onClick={onHide}
            className="border px-1.5 text-[9px] font-bold leading-[16px] tracking-[0.1em] transition-colors hover:bg-white/5"
            style={{
              color: paletteVar("text"),
              borderColor: withAlpha(paletteVar("text"), 27),
            }}
            title="Hide this section (Settings → ORDER DEPTH brings it back)"
          >
            HIDE
          </button>
        </span>
      }
    >
      {!data ? (
        error ? (
          <div
            className="text-[11px]"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            Order-book feed unavailable right now.
          </div>
        ) : (
          <div className="space-y-2" aria-busy="true">
            <Skeleton height={44} />
            <Skeleton height={110} />
          </div>
        )
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_248px] gap-3">
          <div className="space-y-3 min-w-0">
            <DepthHeadline data={data} />
            <DepthCoreChart
              data={data}
              pulse={pulse}
              animate={animate}
              width={640}
              height={104}
            />
            {data.walls.length > 0 && (
              <div>
                <div
                  className="pb-1 text-[9px] tracking-[0.16em]"
                  style={{ color: paletteVar("text"), opacity: 0.6 }}
                >
                  LIQUIDITY WALLS
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-px">
                  {data.walls.slice(0, 6).map((w) => (
                    <WallRow key={`${w.side}-${w.price}`} wall={w} mid={data.mid} />
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="min-w-0">
            <TapeBlock data={data} pulse={pulse} animate={animate} sparkWidth={240} />
          </div>
        </div>
      )}
    </CornerBox>
  )
}

/**
 * The /stats -> ZEC -> ORDER FLOW view. Everything the feed knows, plus the
 * price-action analytics computed from the daily history the page already
 * fetched (`history`) — no extra request for this panel.
 */
export function OrderFlowPanels({
  history,
  isMobile = false,
}: {
  history?: PricesHistoryPoint[]
  isMobile?: boolean
}) {
  const { data, error } = useZecDepth()
  const motion = useMotionPref()
  const animate = motion !== "off"
  const pulse = useDepthPulse(data)
  const chartW = isMobile ? 360 : 900

  if (!data) {
    return (
      <CornerBox label="AGGREGATED ORDER BOOK" color={paletteVar("zec")}>
        {error ? (
          <div
            className="text-[11px]"
            style={{ color: paletteVar("text"), opacity: 0.6 }}
          >
            The order-book feed is unavailable right now. It aggregates six
            exchange books live, so this usually clears on its own within a
            minute.
          </div>
        ) : (
          <div className="space-y-2" aria-busy="true">
            <Skeleton height={44} />
            <Skeleton height={170} />
            <Skeleton height={80} />
          </div>
        )}
      </CornerBox>
    )
  }

  return (
    <div className="space-y-3">
      <CornerBox
        label="AGGREGATED ORDER BOOK"
        color={paletteVar("zec")}
        action={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <VenueChip data={data} />
            <FeedFooter data={data} />
          </span>
        }
      >
        <div className="space-y-3">
          <DepthHeadline data={data} />
          <DepthCoreChart
            data={data}
            pulse={pulse}
            animate={animate}
            width={chartW}
            height={isMobile ? 132 : 176}
          />
          {data.walls.length > 0 && (
            <div>
              <div
                className="pb-1 text-[9px] tracking-[0.16em]"
                style={{ color: paletteVar("text"), opacity: 0.6 }}
              >
                LIQUIDITY WALLS · BIGGEST RESTING BLOCKS WITHIN ±
                {(data.maxBps / 100).toFixed(0)}%
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px">
                {data.walls.map((w) => (
                  <WallRow key={`${w.side}-${w.price}`} wall={w} mid={data.mid} />
                ))}
              </div>
            </div>
          )}
        </div>
      </CornerBox>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <CornerBox label="LIQUIDITY LADDER" color={paletteVar("cyph")}>
          <LadderTable data={data} />
        </CornerBox>
        <CornerBox label="MARKET IMPACT" color={paletteVar("ratio")}>
          <ImpactTable data={data} />
        </CornerBox>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <CornerBox label="TAPE · TAKER FLOW" color={paletteVar("cyph")}>
          <TapeBlock
            data={data}
            pulse={pulse}
            animate={animate}
            sparkWidth={isMobile ? 320 : 420}
          />
        </CornerBox>
        <CornerBox label="VENUES" color={paletteVar("zec")}>
          <VenueTable data={data} />
        </CornerBox>
      </div>

      <CornerBox label="PRICE ACTION" color={paletteVar("ratio")}>
        <PriceActionBlock
          data={data}
          history={history}
          chartWidth={chartW}
        />
      </CornerBox>
    </div>
  )
}
