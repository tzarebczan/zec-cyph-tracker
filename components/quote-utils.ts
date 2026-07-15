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
  // A present extended-hours price must not be dropped just because its
  // timestamp is missing — some fallback/cached quote paths carry the price
  // but not the tick time. Silently discarding it fell through to the last
  // regular close, which is what surfaced a stale "closing" price while the
  // session badge still read PRE/AFT/OVN. Missing times sort last (0) so a
  // timestamped print still wins, but an untimed live print beats the close.
  const candidates: { price: number; time: number }[] = []
  if (q.overnightMarketPrice != null)
    candidates.push({
      price: q.overnightMarketPrice,
      time: q.overnightMarketTime ?? 0,
    })
  if (q.postMarketPrice != null)
    candidates.push({ price: q.postMarketPrice, time: q.postMarketTime ?? 0 })
  if (q.preMarketPrice != null)
    candidates.push({ price: q.preMarketPrice, time: q.preMarketTime ?? 0 })
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.time - a.time)
    return candidates[0].price
  }
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

  type Cand = {
    session: LiveCyphSession
    price: number
    time: number
    change: number | null
    changePct: number | null
  }
  // Mirror `pickLiveCyph`: accept a present extended-hours price even when
  // its timestamp is missing (untimed prints sort last via `?? 0`) so the
  // session detail tracks the same price the headline shows and never
  // silently degrades to the regular close while claiming an active session.
  const candidates: Cand[] = []
  if (q.overnightMarketPrice != null) {
    candidates.push({
      session: "OVN",
      price: q.overnightMarketPrice,
      time: q.overnightMarketTime ?? 0,
      change: q.overnightMarketChange,
      changePct: q.overnightMarketChangePercent,
    })
  }
  if (q.postMarketPrice != null) {
    candidates.push({
      session: "POST",
      price: q.postMarketPrice,
      time: q.postMarketTime ?? 0,
      change: q.postMarketChange,
      changePct: q.postMarketChangePercent,
    })
  }
  if (q.preMarketPrice != null) {
    candidates.push({
      session: "PRE",
      price: q.preMarketPrice,
      time: q.preMarketTime ?? 0,
      change: q.preMarketChange,
      changePct: q.preMarketChangePercent,
    })
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.time - a.time)
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
