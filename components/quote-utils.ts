import type { QuoteSnapshot } from "./api-types"

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

function isRegularTradingWindowEt(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value
  const weekday = get("weekday")
  if (weekday === "Sat" || weekday === "Sun") return false
  const hour = Number(get("hour"))
  const minute = Number(get("minute"))
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false
  const minutes = hour * 60 + minute
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60
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
    // Guard the open transition. At 9:30 ET Yahoo flips marketState to REGULAR
    // a few seconds before the first live regular tick lands, so
    // regularMarketPrice is still yesterday's close while a fresh pre-market
    // print sits in the extended fields. If any extended print is newer than
    // the regular tick, a later session (pre-market at the open) is the
    // freshest real price — defer to it (pickLiveCyph surfaces it) until the
    // regular tick catches up, instead of flashing a stale close and tripping
    // the dashboard's HOLIDAY badge. On a genuine holiday nothing trades after
    // the last regular close, so no extended print is newer and we keep
    // REGULAR (the holiday badge then takes over as before).
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
  session: Exclude<LiveCyphSession, "REGULAR">
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

/** Live CYPH price the beta surfaces should display.
 *
 *  Picks the same way the legacy `PriceDashboard` does:
 *    - During REGULAR session, return `regularMarketPrice` directly.
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
export type LiveCyphSession = "REGULAR" | "PRE" | "POST" | "OVN"

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
