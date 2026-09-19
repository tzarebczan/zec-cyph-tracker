import type { QuoteSnapshot } from "./api-types"
import {
  isRegularTradingWindowEt,
  marketSessionState,
} from "@/lib/market-session"

type RegularSessionQuote = Pick<
  QuoteSnapshot,
  | "marketState"
  | "regularMarketPrice"
  | "regularMarketTime"
  | "preMarketPrice"
  | "preMarketTime"
  | "postMarketPrice"
  | "postMarketTime"
  | "overnightMarketPrice"
  | "overnightMarketTime"
>

const FRESH_REGULAR_TICK_MS = 20 * 60 * 1000

/** Newest timestamp (unix seconds) among the populated extended-hours prints,
 *  or null when none carry a usable timestamp. Used to detect the open
 *  transition, where a fresh pre-market print is newer than a still-stale
 *  regular tick. */
function newestExtendedPrintTime(q: RegularSessionQuote): number | null {
  const times: number[] = []
  if (q.preMarketPrice != null && q.preMarketTime != null) times.push(q.preMarketTime)
  if (q.postMarketPrice != null && q.postMarketTime != null) times.push(q.postMarketTime)
  if (q.overnightMarketPrice != null && q.overnightMarketTime != null) {
    times.push(q.overnightMarketTime)
  }
  return times.length ? Math.max(...times) : null
}

export function hasFreshRegularSessionQuote(
  q?: RegularSessionQuote | null
): boolean {
  if (!q || q.regularMarketPrice == null || q.regularMarketTime == null) {
    return false
  }
  const ageMs = Date.now() - q.regularMarketTime * 1000
  return ageMs >= -60_000 && ageMs < FRESH_REGULAR_TICK_MS
}

export function shouldUseRegularSessionQuote(
  q?: RegularSessionQuote | null
): boolean {
  if (!q || q.regularMarketPrice == null) return false
  if (q.marketState === "REGULAR") {
    // If the market is not currently in its regular trading window (holiday,
    // weekend, or outside 9:30-16:00 ET), an upstream quote reporting REGULAR
    // is stale and should not be treated as live regular trading.
    if (!isRegularTradingWindowEt()) return false

    // Guard the open transition. At 9:30 ET Yahoo flips marketState to REGULAR
    // a few seconds before the first live regular tick lands, so
    // regularMarketPrice is still yesterday's close while a fresh pre-market
    // print sits in the extended fields. If any extended print is newer than
    // the regular tick, a later session (pre-market at the open) is the
    // freshest real price — defer to it (pickLiveCyph surfaces it) until the
    // regular tick catches up, instead of flashing a stale close and tripping
    // the dashboard's HOLIDAY badge.
    const rt = q.regularMarketTime ?? null
    const ext = newestExtendedPrintTime(q)
    if (rt != null && ext != null && ext > rt) return false
    return true
  }
  return isRegularTradingWindowEt() && hasFreshRegularSessionQuote(q)
}


/** Whether an extended-hours print has been superseded by a regular close.
 *
 *  Yahoo leaves every session's fields populated all day, and the post-market
 *  fields stay empty for the first minute or two after 16:00, while no
 *  after-hours print has landed. Ranking extended prints on timestamp alone
 *  therefore picks THIS MORNING's pre-market print at the close and presents
 *  it as the live session. Measured at 16:00 on Aug 31: the tile read PRE
 *  with 09:29's $1.73 and its +$0.02 (+1.17%), beside "Close $1.82 · Mon
 *  3:59 PM ET" — stale, the wrong session, and self-contradictory, since
 *  +$0.02 on a $1.82 close is $1.84. It righted itself a minute later when
 *  Yahoo published a post-market price.
 *
 *  No calendar needed: a regular close supersedes every extended print before
 *  it, so a print at or before `regularMarketTime` belongs to a session that
 *  is over. One clock — Yahoo's — on both sides of the comparison.
 *
 *  An untimed print is never superseded. Some cached paths carry the price
 *  without its tick time, and discarding those falls through to the regular
 *  close while the badge goes on claiming a live session, which is the bug
 *  this ordering was written to fix in the first place.
 *
 *  Strictly earlier, not "at or before". Equal timestamps mean the precision
 *  ran out, not that the print is stale: the Nasdaq fallback in
 *  `app/api/quote/route.ts` parses only hour and minute, so a genuine
 *  post-market tick in the first seconds after the close carries the same
 *  16:00 as the close itself. Rejecting that would throw away a real
 *  after-hours price to avoid a stale one, and the print this guard exists
 *  to catch is hours earlier, never a tie. */
export function supersededByClose(
  printTime: number | null | undefined,
  closeTime: number | null | undefined
): boolean {
  return printTime != null && closeTime != null && printTime < closeTime
}

/** Extended-hours prints from a quote, freshest first, with any the last
 *  regular close has superseded dropped. Shared by `pickLiveCyph` and
 *  `pickLiveCyphSession` so the headline price and the session badge beside
 *  it can never come from different prints. */
function extendedPrints(q: QuoteSnapshot): {
  session: Exclude<LiveCyphSession, "REGULAR" | "24X7">
  price: number
  time: number | null
  change: number | null
  changePct: number | null
}[] {
  const all = []
  if (q.overnightMarketPrice != null) {
    all.push({
      session: "OVN" as const,
      price: q.overnightMarketPrice,
      time: q.overnightMarketTime,
      change: q.overnightMarketChange,
      changePct: q.overnightMarketChangePercent,
    })
  }
  if (q.postMarketPrice != null) {
    all.push({
      session: "POST" as const,
      price: q.postMarketPrice,
      time: q.postMarketTime,
      change: q.postMarketChange,
      changePct: q.postMarketChangePercent,
    })
  }
  if (q.preMarketPrice != null) {
    all.push({
      session: "PRE" as const,
      price: q.preMarketPrice,
      time: q.preMarketTime,
      change: q.preMarketChange,
      changePct: q.preMarketChangePercent,
    })
  }
  const live = all.filter((p) => !supersededByClose(p.time, q.regularMarketTime))
  // Untimed prints sort last, so a timestamped one still wins.
  live.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
  return live
}

/** How long a 24x7 print stays usable after it was observed. Matches the
 *  server's `CYPH_247_STALE_TTL_MS`: /api/quote stops sending the print
 *  once its own cache is that old, so this is the backstop for a tab that
 *  paused polling and is still holding an older payload. */
const TOKEN_FRESH_MS = 15 * 60 * 1000

type OffHoursQuote = {
  tokenMarketPrice?: number | null
  tokenMarketTime?: number | null
  tokenMarketChange?: number | null
  tokenMarketChangePercent?: number | null
  tokenMarketSource?: string | null
  overnightMarketPrice?: number | null
  overnightMarketTime?: number | null
  postMarketPrice?: number | null
  postMarketTime?: number | null
  preMarketPrice?: number | null
  preMarketTime?: number | null
}

/** Whether the 24x7 token print should stand in for a US print right now.
 *
 *  Yes when no US venue is trading — not regular, pre, after-hours or Blue
 *  Ocean overnight: weekends (Fri 20:00 → Sun 20:00 ET), market holidays
 *  and the evening before one. While any US session is open its prints stay
 *  authoritative, with one exception: the overnight session counts as open
 *  from 20:00 ET even before Blue Ocean has traded a share, and on a thin
 *  name that can be hours. Without the exception the tile would step from
 *  the live Solana price to *Friday's* after-hours print at Sunday 20:00,
 *  labelled AFT, and hold it until the first overnight trade. So during
 *  OVERNIGHT the token print keeps the headline until a print from *this*
 *  overnight window lands, and the freshest real market wins either way. */
function tokenPrintApplies(q: OffHoursQuote, at: Date): boolean {
  const state = marketSessionState(at)
  if (!state) return false
  const current = state.current
  if (!current) return true
  if (current.session !== "OVERNIGHT") return false
  const startSec = current.start / 1000
  const printedThisWindow = (price?: number | null, time?: number | null) =>
    price != null && time != null && time >= startSec
  return !(
    printedThisWindow(q.overnightMarketPrice, q.overnightMarketTime) ||
    printedThisWindow(q.postMarketPrice, q.postMarketTime) ||
    printedThisWindow(q.preMarketPrice, q.preMarketTime)
  )
}

/** The tokenized-share print, when it should stand in for the US market and
 *  is fresh enough to. Null otherwise. */
export function offHoursPrint(q?: OffHoursQuote | null): {
  price: number
  time: number | null
  change: number | null
  changePct: number | null
} | null {
  if (!q || q.tokenMarketPrice == null) return null
  const now = new Date()
  if (!tokenPrintApplies(q, now)) return null
  if (
    q.tokenMarketTime != null &&
    now.getTime() - q.tokenMarketTime * 1000 > TOKEN_FRESH_MS
  ) {
    return null
  }
  return {
    price: q.tokenMarketPrice,
    time: q.tokenMarketTime ?? null,
    change: q.tokenMarketChange ?? null,
    changePct: q.tokenMarketChangePercent ?? null,
  }
}

/** Live CYPH price the beta surfaces should display.
 *
 *  Picks the same way the legacy `PriceDashboard` does:
 *    - During REGULAR session, return `regularMarketPrice` directly.
 *    - When every US venue is shut, return the 24x7 tokenized-share print
 *      (Solana) — the only market actually trading CYPH at that moment.
 *    - Otherwise, return whichever extended-hours print is freshest:
 *      overnight (Blue Ocean ATS, 8 PM – 4 AM ET) → post-market →
 *      pre-market, sorted by their reported timestamps.
 *    - Fall back to `regularMarketPrice` (last regular close), then
 *      to `regularMarketPreviousClose` so we never blank the page.
 *
 *  Shared between dashboard / portfolio / estimator so navigating
 *  between pages doesn't surface a different price for the same
 *  moment in time.
 */
export function pickLiveCyph(q?: QuoteSnapshot | null): number | null {
  if (!q) return null
  if (shouldUseRegularSessionQuote(q)) {
    return q.regularMarketPrice
  }
  const offHours = offHoursPrint(q)
  if (offHours) return offHours.price
  // Shared with pickLiveCyphSession so the headline price and the session
  // badge beside it can never come from different prints.
  const live = extendedPrints(q)
  if (live.length > 0) return live[0].price
  return q.regularMarketPrice ?? q.regularMarketPreviousClose ?? null
}

/** Identifier for which session the dashboard's headline price is currently
 *  sourced from. `REGULAR` covers both an actively-trading session and the
 *  static last-print case after the close when no extended-hours tick has
 *  arrived yet. */
export type LiveCyphSession = "REGULAR" | "PRE" | "POST" | "OVN" | "24X7"

/** Badge text for a sourced session — the one vocabulary every CYPH surface
 *  uses so the dashboard chip, the portfolio label and the pop-out widget
 *  can't disagree about what a session is called. */
export function liveCyphSessionBadge(session: LiveCyphSession): string {
  return session === "REGULAR"
    ? "OPEN"
    : session === "PRE"
      ? "PRE"
      : session === "POST"
        ? "AFT"
        : session === "OVN"
          ? "OVN"
          : "24x7"
}

/** What the 24x7 print actually is, for the delta line and portfolio
 *  captions: the Solana tokenized share by default, or the perp when the
 *  route fell all the way back to Gate. A perp tracks the stock through
 *  funding rather than redemption and must never be captioned as a share. */
export function offHoursVenueLabel(
  q?: { tokenMarketSource?: string | null } | null
): string {
  return q?.tokenMarketSource === "gate-perp" ? "Perp 24x7" : "Solana 24x7"
}

/** How far a 24x7 print must sit from the last regular close before the UI
 *  marks it as dislocated (asterisk + info panel) rather than presenting it
 *  as a plain CYPH price. The tokenized share only tracks the Nasdaq share
 *  while someone can redeem it, and redemption is gated on a US session —
 *  over a weekend the two can part company by a lot. Well clear of an
 *  ordinary session's move, well inside the premium seen at launch. */
export const CYPH_247_DISLOCATION_PCT = 25

/** Whether a 24x7 print has parted company with the last regular close far
 *  enough to need marking. Direction-agnostic: a discount misleads exactly
 *  as much as a premium. */
export function isDislocated247(changePct?: number | null): boolean {
  return changePct != null && Math.abs(changePct) >= CYPH_247_DISLOCATION_PCT
}

/** The asterisk that flags a dislocated 24x7 print, for surfaces with no room
 *  for the explainer panel (the pop-out widget, the OG card). Same threshold
 *  as the panel, so one print is never marked on one surface and bare on
 *  another. Lives here, not beside the panel, so the OG route can mark the
 *  badge without pulling a client component into the image runtime. */
export function dislocationMark(changePct?: number | null): string {
  return isDislocated247(changePct) ? "*" : ""
}

/** Longer form of `offHoursVenueLabel` for captions with room. */
export function offHoursVenueDescription(
  q?: { tokenMarketSource?: string | null } | null
): string {
  return q?.tokenMarketSource === "gate-perp"
    ? "CYPH/USDT perpetual (US market closed)"
    : "Solana tokenized share (US market closed)"
}

export interface LiveCyphSessionDetail {
  /** The session driving the live price (matches `pickLiveCyph`'s output). */
  session: LiveCyphSession
  /** The live price itself — same value `pickLiveCyph` returns. */
  price: number | null
  /** Absolute $ change of the live price vs the prior regular close
   *  (Yahoo's `<session>MarketChange`). Null on REGULAR. */
  change: number | null
  /** Percent change of the live price vs the prior regular close
   *  (Yahoo's `<session>MarketChangePercent`). Null on REGULAR. */
  changePct: number | null
  /** Unix-seconds timestamp of the live tick (Yahoo's `<session>MarketTime`). */
  time: number | null
  /** Last regular-session close — what the AH delta is measured against.
   *
   *  Yahoo's field semantics flip depending on session:
   *    - During REGULAR hours, `regularMarketPrice` is LIVE and
   *      `regularMarketPreviousClose` holds the prior session's close
   *      (yesterday's close on a normal trading day) — that's what
   *      `regularMarketChange` is computed against, so it's the right
   *      "vs close" reference.
   *    - During PRE/POST/OVN, `regularMarketPrice` instead holds the
   *      MOST RECENT completed regular close (today's close in post-
   *      market, yesterday's close in pre-market the next day), and
   *      `regularMarketPreviousClose` is the close BEFORE that.
   *      Yahoo's `<session>MarketChange` is computed against
   *      `regularMarketPrice`, NOT `regularMarketPreviousClose`, so
   *      that's the field the UI must surface as "Close $X" alongside
   *      the AH delta. Picking the wrong field puts the dashboard out
   *      of sync (e.g. "+$0.03 vs close $1.13" when the implied close
   *      is $1.05). */
  prevClose: number | null
  /** Unix-seconds timestamp of the last regular-session tick. Lets the UI
   *  render "Close $7.92 · Tue 4:00pm ET" alongside the AH delta so users
   *  can tell at-a-glance when the reference point was set. */
  prevCloseTime: number | null
}

/** Companion to `pickLiveCyph` that surfaces *why* a particular price is
 *  live and what its delta vs the last regular close is. The dashboard
 *  uses this to render an AH-aware second line ("AFT +$0.12 / +1.5% vs
 *  close") instead of relying on the daily-candle 24h % which obscures
 *  the actual after-hours move. */
export function pickLiveCyphSession(
  q?: QuoteSnapshot | null
): LiveCyphSessionDetail {
  const empty: LiveCyphSessionDetail = {
    session: "REGULAR",
    price: null,
    change: null,
    changePct: null,
    time: null,
    prevClose: null,
    prevCloseTime: null,
  }
  if (!q) return empty

  if (shouldUseRegularSessionQuote(q)) {
    return {
      session: "REGULAR",
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePct: q.regularMarketChangePercent,
      time: q.regularMarketTime,
      prevClose: q.regularMarketPreviousClose,
      prevCloseTime: q.regularMarketTime,
    }
  }

  // Every US venue shut: the Solana tokenized share is the live market, and
  // its delta is measured against the last regular close like any other
  // extended print (see tokenMarketFields in /api/quote).
  const offHours = offHoursPrint(q)
  if (offHours) {
    return {
      session: "24X7",
      price: offHours.price,
      change: offHours.change,
      changePct: offHours.changePct,
      time: offHours.time,
      prevClose: q.regularMarketPrice ?? q.regularMarketPreviousClose,
      prevCloseTime: q.regularMarketTime,
    }
  }

  // The same ordered prints `pickLiveCyph` picks from, so this detail always
  // describes the price the headline is showing.
  const candidates = extendedPrints(q)
  if (candidates.length > 0) {
    const c = candidates[0]
    return {
      session: c.session,
      price: c.price,
      change: c.change,
      changePct: c.changePct,
      time: c.time,
      // ROOT-CAUSE FIX: in extended hours, the AH delta
      // (`<session>MarketChange`) is computed against
      // `regularMarketPrice` (= last completed regular close), NOT
      // against `regularMarketPreviousClose` (= the close BEFORE that
      // last close). Surfacing `regularMarketPreviousClose` here put
      // the UI out of sync with its own delta (e.g. "+$0.03 vs close
      // $1.13" when the implied close was $1.05 / Mon, and $1.13 was
      // Fri). `regularMarketPreviousClose` is kept as a defensive
      // fallback for the rare case where `regularMarketPrice` is
      // missing.
      prevClose: q.regularMarketPrice ?? q.regularMarketPreviousClose,
      prevCloseTime: q.regularMarketTime,
    }
  }

  // No extended-hours tick available yet (e.g. weekend before pre-market
  // opens). Fall through to the last regular print, treating it as the
  // headline; UI can render "Last close" labelling around it.
  if (q.regularMarketPrice != null) {
    return {
      session: "REGULAR",
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePct: q.regularMarketChangePercent,
      time: q.regularMarketTime,
      prevClose: q.regularMarketPreviousClose,
      prevCloseTime: q.regularMarketTime,
    }
  }
  return {
    ...empty,
    price: q.regularMarketPreviousClose ?? null,
    prevClose: q.regularMarketPreviousClose,
  }
}
