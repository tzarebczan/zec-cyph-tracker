"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { usePageVisible } from "@/hooks/use-page-visible"
import { CornerBox, ETabs, InfoTip, Skeleton } from "./primitives"
import { paletteVar, withAlpha, E_STATIC } from "./theme"
import { fmtCompactNumber, swrFetcher } from "./format"
import type {
  CyphFlowResponse,
  CyphFlowSession,
  CyphFlowSessionId,
} from "./api-types"

// CYPH executed flow, the companion to the resting book in ./cyph-depth.
//
// The split is deliberate and is the axis the whole panel is organised on:
// the BOOK card shows liquidity that was WAITING (T+1, licensed data), this
// one shows trades that HAPPENED (near-live, free from Nasdaq). Mixing them
// in one card invites reading a day-old bid against today's prints.

const UP = () => paletteVar("cyph")
const DOWN = () => E_STATIC.red

const POLL_MS = 60_000

const SESSION_LABEL: Record<CyphFlowSessionId, string> = {
  PRE: "PRE",
  REGULAR: "REG",
  POST: "AFT",
}

const SESSION_NAME: Record<CyphFlowSessionId, string> = {
  PRE: "Pre-market",
  REGULAR: "Regular session",
  POST: "After-hours",
}

export function useCyphFlow() {
  const visible = usePageVisible()
  return useSWR<CyphFlowResponse>("/api/cyph-flow", swrFetcher, {
    refreshInterval: visible ? POLL_MS : 0,
    keepPreviousData: true,
  })
}

function Stat({
  label,
  value,
  color,
  tip,
}: {
  label: string
  value: string
  color?: string
  tip?: string
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[9px] tracking-[0.16em] leading-none">
        <span style={{ color: paletteVar("text"), opacity: 0.65 }}>{label}</span>
        {tip && (
          <InfoTip label={label} align="center">
            {tip}
          </InfoTip>
        )}
      </div>
      <div
        className="mt-1 text-[13px] font-bold tabular-nums leading-none truncate"
        style={{ color: color ?? paletteVar("text") }}
      >
        {value}
      </div>
    </div>
  )
}

/** Volume by price over the prints held for this session, highest price at the
 *  top so it reads like the book's ladder. Split by tick direction: the part
 *  of each bar that printed on an uptick is drawn in the up colour. */
function VolumeByPrice({ session }: { session: CyphFlowSession }) {
  const levels = useMemo(() => session.levels.slice(0, 14), [session])
  const peak = useMemo(
    () => levels.reduce((m, l) => Math.max(m, l.size), 0),
    [levels]
  )
  if (levels.length === 0) return null
  return (
    <div className="mt-3 space-y-px">
      {levels.map((l) => {
        const pct = peak > 0 ? (l.size / peak) * 100 : 0
        const upShare = l.size > 0 ? (l.upSize / l.size) * 100 : 0
        return (
          <div key={l.price} className="flex items-center gap-2 text-[10px]">
            <span
              className="tabular-nums w-[52px] shrink-0 text-right"
              style={{ color: paletteVar("text"), opacity: 0.8 }}
            >
              {l.price.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}
            </span>
            <div className="h-[10px] flex-1 min-w-0">
              <div className="h-full flex" style={{ width: `${Math.max(pct, 1)}%` }}>
                <div style={{ width: `${upShare}%`, background: withAlpha(UP(), 60) }} />
                <div style={{ width: `${100 - upShare}%`, background: withAlpha(DOWN(), 60) }} />
              </div>
            </div>
            <span
              className="tabular-nums w-[54px] shrink-0 text-right"
              style={{ color: paletteVar("text"), opacity: 0.65 }}
            >
              {fmtCompactNumber(l.size)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** The tape itself. Capped rather than scrolled: a scroll region inside a
 *  card that is itself inside a tab is one nested scroll too many on a
 *  phone, and the newest prints are the ones anyone reads. */
function Tape({ session }: { session: CyphFlowSession }) {
  const prints = session.prints.slice(0, 18)
  if (prints.length === 0) return null
  return (
    <div className="mt-3">
      <div
        className="grid grid-cols-3 gap-2 text-[9px] tracking-[0.16em] pb-1"
        style={{ color: paletteVar("text"), opacity: 0.5 }}
      >
        <span>TIME ET</span>
        <span className="text-right">PRICE</span>
        <span className="text-right">SHARES</span>
      </div>
      <div className="space-y-px">
        {prints.map((p, i) => (
          <div
            key={`${p.time}-${i}`}
            className="grid grid-cols-3 gap-2 text-[10px] tabular-nums"
          >
            <span style={{ color: paletteVar("text"), opacity: 0.6 }}>{p.time}</span>
            <span
              className="text-right"
              style={{ color: p.tick === "down" ? DOWN() : p.tick === "up" ? UP() : paletteVar("text") }}
            >
              {p.price.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}
            </span>
            <span className="text-right" style={{ color: paletteVar("text"), opacity: 0.75 }}>
              {p.size.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function CyphFlowPanel({ className }: { className?: string }) {
  const { data, error } = useCyphFlow()
  const [picked, setPicked] = useState<CyphFlowSessionId | null>(null)

  const sessions = data?.sessions ?? []
  // Prefer whichever session actually has a tape — landing on an empty PRE
  // when after-hours is where all the action was is a poor default.
  const withPrints = sessions.filter((s) => s.prints.length > 0)
  const active =
    sessions.find((s) => s.session === picked)?.session ??
    withPrints[withPrints.length - 1]?.session ??
    sessions[0]?.session ??
    null
  const session = sessions.find((s) => s.session === active) ?? null

  if (!data) {
    return (
      <CornerBox label="ORDER FLOW" color={paletteVar("cyph")} className={className}>
        {error ? (
          <div
            className="text-[11px] py-8 text-center"
            style={{ color: paletteVar("text"), opacity: 0.5 }}
          >
            Flow feed unavailable.
          </div>
        ) : (
          <Skeleton className="mt-2" height={220} />
        )}
      </CornerBox>
    )
  }

  const upSize = session?.prints.reduce((n, p) => n + (p.tick === "up" ? p.size : 0), 0) ?? 0
  const downSize =
    session?.prints.reduce((n, p) => n + (p.tick === "down" ? p.size : 0), 0) ?? 0
  const tickTotal = upSize + downSize

  return (
    <CornerBox
      label="ORDER FLOW"
      color={paletteVar("cyph")}
      className={className}
      action={
        sessions.length > 1 ? (
          <ETabs
            items={sessions.map((s) => [s.session, SESSION_LABEL[s.session]] as const)}
            active={active as CyphFlowSessionId}
            onChange={setPicked}
            compact
          />
        ) : undefined
      }
    >
      {!session ? (
        <div
          className="text-[11px] py-8 text-center"
          style={{ color: paletteVar("text"), opacity: 0.5 }}
        >
          No flow published yet.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-1">
            <Stat
              label="LAST"
              value={session.last != null ? `$${session.last.toFixed(2)}` : "—"}
            />
            <Stat
              label="CHANGE"
              value={
                session.changePct != null
                  ? `${session.changePct > 0 ? "+" : ""}${session.changePct.toFixed(2)}%`
                  : "—"
              }
              color={
                session.changePct == null
                  ? undefined
                  : session.changePct >= 0
                    ? UP()
                    : DOWN()
              }
              tip="Session move against the prior regular close, as the exchange reports it."
            />
            <Stat
              label="VOLUME"
              value={session.volume != null ? fmtCompactNumber(session.volume) : "—"}
              tip="Official consolidated share volume for the whole session — complete, unlike the tape below."
            />
            <Stat
              label="RANGE"
              value={
                session.low != null && session.high != null
                  ? `$${session.low.toFixed(2)}–${session.high.toFixed(2)}`
                  : "—"
              }
              tip={
                session.highAt || session.lowAt
                  ? `High ${session.highAt ?? "—"} · low ${session.lowAt ?? "—"} ET.`
                  : undefined
              }
            />
          </div>

          {tickTotal > 0 && (
            <div className="mt-3">
              <div className="flex h-[6px] w-full overflow-hidden">
                <div
                  style={{ width: `${(upSize / tickTotal) * 100}%`, background: withAlpha(UP(), 85) }}
                />
                <div
                  style={{ width: `${(downSize / tickTotal) * 100}%`, background: withAlpha(DOWN(), 85) }}
                />
              </div>
              <div className="mt-1 flex items-baseline justify-between text-[10px] tabular-nums">
                <span style={{ color: UP() }}>{fmtCompactNumber(upSize)} on upticks</span>
                <span style={{ color: DOWN() }}>{fmtCompactNumber(downSize)} on downticks</span>
              </div>
            </div>
          )}

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <div
                className="flex items-center gap-1 text-[9px] tracking-[0.16em]"
                style={{ color: paletteVar("text") }}
              >
                <span style={{ opacity: 0.65 }}>VOLUME BY PRICE</span>
                <InfoTip label="Volume by price" align="center">
                  Shares printed at each price across the{" "}
                  {session.prints.length} most recent trades, split by whether
                  each printed on an uptick or a downtick. This is the tape
                  sample, <strong>not</strong> the session — the exchange
                  publishes only the last ~100 prints, so use VOLUME above for
                  session size and this for where recent trading clustered.
                </InfoTip>
              </div>
              <VolumeByPrice session={session} />
            </div>
            <div className="min-w-0">
              <div
                className="text-[9px] tracking-[0.16em]"
                style={{ color: paletteVar("text"), opacity: 0.65 }}
              >
                TAPE
              </div>
              <Tape session={session} />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className="text-[10px] tracking-[0.12em]"
              style={{ color: paletteVar("text"), opacity: 0.5 }}
            >
              {SESSION_NAME[session.session]}
              {session.sampled ? ` · last ${session.prints.length} prints` : ""}
            </span>
            {session.asOf && (
              <span
                className="text-[10px] tracking-[0.12em]"
                style={{ color: paletteVar("text"), opacity: 0.4 }}
              >
                {session.asOf}
              </span>
            )}
            {session.message && session.prints.length === 0 && (
              <span
                className="text-[10px] tracking-[0.12em]"
                style={{ color: paletteVar("amber"), opacity: 0.7 }}
              >
                {session.message}
              </span>
            )}
          </div>
        </>
      )}
    </CornerBox>
  )
}
