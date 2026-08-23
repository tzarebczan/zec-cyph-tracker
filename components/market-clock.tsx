"use client"

import { useEffect, useState } from "react"
import { usePageVisible } from "@/hooks/use-page-visible"
import { paletteVar } from "./theme"
import {
  fmtCountdown,
  fmtEtSessionTime,
  marketSessionState,
  sessionBadge,
  sessionName,
  type SessionState,
} from "@/lib/market-session"

/** The countdown only ever renders whole minutes, so a 20s tick is enough to
 *  keep it honest while costing four renders a minute. */
const TICK_MS = 20_000

/** Live US equity session state, recomputed on a timer.
 *
 *  Returns null on the server and on the first client render so the markup
 *  hydrates identically either way — the schedule depends on the viewer's
 *  clock, which the server can't know, and rendering a server-side guess
 *  would produce a hydration mismatch on every load.
 *
 *  The timer stops while the tab is hidden (nobody is reading a stale
 *  countdown), and re-reads immediately on the way back so a backgrounded
 *  PWA doesn't flash yesterday's session on resume. */
export function useMarketSession(): SessionState | null {
  const visible = usePageVisible()
  const [state, setState] = useState<SessionState | null>(null)

  useEffect(() => {
    if (!visible) return
    const read = () => setState(marketSessionState())
    read()
    const id = setInterval(read, TICK_MS)
    return () => clearInterval(id)
  }, [visible])

  return state
}

/** Compact session countdown for a tile header.
 *
 *  In a session it counts down to that session's close; between sessions it
 *  names the next venue to open and counts down to it, so the tile always
 *  answers "how long have I got / when does it wake up" in one glance. The
 *  exact boundary lives in the tooltip rather than the label, which has to
 *  survive a 320px-wide tile alongside the title, status chip and mining
 *  chip. */
export function SessionClock({ className = "" }: { className?: string }) {
  const state = useMarketSession()
  if (!state) return null

  const { current, next, msToClose, msToOpen } = state
  let text: string
  let title: string

  if (current && msToClose != null) {
    text = fmtCountdown(msToClose)
    title =
      `${sessionName(current.session)} closes ${fmtEtSessionTime(current.end)}` +
      (current.earlyClose ? " (early close)" : "") +
      (next ? ` · ${sessionName(next.session)} opens ${fmtEtSessionTime(next.start)}` : "")
  } else if (next && msToOpen != null) {
    text = `${sessionBadge(next.session)} ${fmtCountdown(msToOpen)}`
    title =
      `${sessionName(next.session)} opens ${fmtEtSessionTime(next.start)}` +
      (state.holiday ? " · market holiday today" : "")
  } else {
    return null
  }

  return (
    <span
      // `min-w-0 truncate`, not `shrink-0`: this is the one item in the tile
      // header that may give up width. Title, status chip and DEPTH are all
      // fixed-size, so if nothing yields, a long pairing — HOLIDAY beside
      // "OVN 2D 10H", reachable on Good Friday — overflows a 211px four-column
      // tile and laps the DEPTH button. Truncating here bounds the row for any
      // content rather than for the strings that happened to be live when it
      // was measured.
      className={`min-w-0 truncate text-[9px] font-bold leading-none tracking-[0.1em] tabular-nums ${className}`}
      style={{ color: paletteVar("text"), opacity: 0.55 }}
      title={title}
    >
      {text}
    </span>
  )
}
