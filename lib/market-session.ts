// US equity market session model — which session CYPH is trading in right
// now, when it ends, and when the next one opens.
//
// Four venues stack across the day, all in America/New_York wall clock:
//
//   OVERNIGHT  20:00 → 04:00 (next day)   Blue Ocean ATS, Sun–Thu evenings
//   PRE        04:00 → 09:30              Nasdaq pre-market
//   REGULAR    09:30 → 16:00              Nasdaq regular hours
//   AFTER      16:00 → 20:00              Nasdaq post-market
//
// Everything is computed from ET wall clock rather than UTC offsets so the
// model stays correct across DST transitions without a special case: we ask
// Intl what the ET calendar/clock reads, and convert an ET wall-clock time
// back to an instant by measuring that date's actual offset.

export type MarketSession = "OVERNIGHT" | "PRE" | "REGULAR" | "AFTER"

/** Full-day US equity market closures. Extended-hours venues are shut too,
 *  so a holiday removes PRE/REGULAR/AFTER entirely and suppresses the
 *  overnight session that would have fed into it.
 *
 *  Hand-maintained: the NYSE publishes these a few years out and they can't
 *  be derived (Good Friday moves, and observed-date rules differ from the
 *  federal calendar — e.g. the NYSE does *not* shift a Saturday New Year's
 *  Day back to the preceding Friday). Past the last year listed we fall back
 *  to plain weekday rules, and the dashboard's existing stale-tick check
 *  still catches an unlisted closure at runtime. */
const HOLIDAYS = new Set<string>([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed — Jul 4 is a Saturday)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
  // 2027
  "2027-01-01", // New Year's Day
  "2027-01-18", // Martin Luther King Jr. Day
  "2027-02-15", // Washington's Birthday
  "2027-03-26", // Good Friday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth (observed — Jun 19 is a Saturday)
  "2027-07-05", // Independence Day (observed — Jul 4 is a Sunday)
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving
  "2027-12-24", // Christmas (observed — Dec 25 is a Saturday)
  // 2028
  "2028-01-17", // Martin Luther King Jr. Day (Jan 1 is a Saturday, not observed)
  "2028-02-21", // Washington's Birthday
  "2028-04-14", // Good Friday
  "2028-05-29", // Memorial Day
  "2028-06-19", // Juneteenth
  "2028-07-04", // Independence Day
  "2028-09-04", // Labor Day
  "2028-11-23", // Thanksgiving
  "2028-12-25", // Christmas
])

/** Half sessions: the regular close moves to 13:00 ET and Nasdaq's
 *  post-market ends at 17:00 instead of 20:00. */
const EARLY_CLOSES = new Set<string>([
  "2026-11-27", // day after Thanksgiving
  "2026-12-24", // Christmas Eve
  "2027-11-26", // day after Thanksgiving
  "2028-07-03", // day before Independence Day
  "2028-11-24", // day after Thanksgiving
])

/** Last year covered by the tables above. Beyond it, `holiday` is reported as
 *  `false` and only weekend rules apply — callers that care can surface the
 *  uncertainty rather than silently trusting a wrong answer. */
export const HOLIDAY_TABLE_THROUGH_YEAR = 2028

const ET = "America/New_York"

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

interface EtNow {
  year: number
  month: number // 1-12
  day: number
  weekday: number // 0 = Sunday
  minutes: number // minutes since ET midnight
}

const etFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: ET,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/** Read the ET calendar date, weekday and time-of-day for an instant. */
export function etNow(at: Date = new Date()): EtNow | null {
  const parts = etFormat.formatToParts(at)
  const get = (type: string) => parts.find((p) => p.type === type)?.value
  const year = Number(get("year"))
  const month = Number(get("month"))
  const day = Number(get("day"))
  const hour = Number(get("hour"))
  const minute = Number(get("minute"))
  const weekday = WEEKDAY_INDEX[get("weekday") ?? ""]
  if (
    ![year, month, day, hour, minute].every(Number.isFinite) ||
    weekday == null
  ) {
    return null
  }
  return { year, month, day, weekday, minutes: hour * 60 + minute }
}

/** Convert an ET wall-clock time to an epoch-ms instant, measuring the
 *  offset actually in force on that date instead of assuming EST or EDT.
 *  Same technique as /api/quote's Nasdaq timestamp parser. */
function etWallClockToMs(
  year: number,
  month: number,
  day: number,
  minutes: number
): number {
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const parts = etFormat.formatToParts(new Date(guess))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const representedAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute")
  )
  // `representedAsUtc - guess` is ET's offset from UTC at that moment
  // (negative), so subtracting it walks the wall-clock time to its instant.
  return guess - (representedAsUtc - guess)
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/** Calendar day after the given ET date, normalised via UTC arithmetic (no
 *  timezone involved — this is pure date math on the ET calendar). */
function nextDay(year: number, month: number, day: number) {
  const d = new Date(Date.UTC(year, month - 1, day + 1))
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
  }
}

/** True when regular + extended Nasdaq sessions run on this ET date. */
export function isTradingDay(
  year: number,
  month: number,
  day: number,
  weekday: number
): boolean {
  if (weekday === 0 || weekday === 6) return false
  return !HOLIDAYS.has(isoDate(year, month, day))
}

export function isMarketHoliday(
  year: number,
  month: number,
  day: number,
  weekday: number
): boolean {
  if (weekday === 0 || weekday === 6) return false
  return HOLIDAYS.has(isoDate(year, month, day))
}

export interface SessionWindow {
  session: MarketSession
  /** Epoch ms when the session opens / closes. */
  start: number
  end: number
  /** True when this window belongs to a 13:00 ET early-close day. */
  earlyClose: boolean
}

/** Every session window that opens on the given ET calendar date. The
 *  overnight window is attributed to the evening it starts, and only exists
 *  when the following day actually trades — Blue Ocean runs Sunday 20:00
 *  through Friday 20:00 ET, so Friday and Saturday evenings have none, and
 *  neither does the evening before a holiday. */
export function windowsForEtDate(
  year: number,
  month: number,
  day: number,
  weekday: number
): SessionWindow[] {
  const out: SessionWindow[] = []
  const at = (minutes: number) => etWallClockToMs(year, month, day, minutes)
  const earlyClose = EARLY_CLOSES.has(isoDate(year, month, day))

  if (isTradingDay(year, month, day, weekday)) {
    const close = earlyClose ? 13 * 60 : 16 * 60
    const afterEnd = earlyClose ? 17 * 60 : 20 * 60
    out.push({ session: "PRE", start: at(4 * 60), end: at(9 * 60 + 30), earlyClose })
    out.push({ session: "REGULAR", start: at(9 * 60 + 30), end: at(close), earlyClose })
    out.push({ session: "AFTER", start: at(close), end: at(afterEnd), earlyClose })
  }

  // Sun–Thu evenings only, and only into a day that trades.
  if (weekday <= 4) {
    const n = nextDay(year, month, day)
    if (isTradingDay(n.year, n.month, n.day, n.weekday)) {
      out.push({
        session: "OVERNIGHT",
        start: at(20 * 60),
        end: etWallClockToMs(n.year, n.month, n.day, 4 * 60),
        earlyClose,
      })
    }
  }

  return out
}

export interface SessionState {
  /** The session trading right now, or null when every venue is shut. */
  current: SessionWindow | null
  /** The next session to open. Null only if we somehow found none within the
   *  search horizon (shouldn't happen — a week always contains a session). */
  next: SessionWindow | null
  /** ms until `current` closes, or null when nothing is trading. */
  msToClose: number | null
  /** ms until `next` opens, or null when we have no next window. */
  msToOpen: number | null
  /** True when the current ET date is a listed full-day market closure. */
  holiday: boolean
  /** True when the current ET date closes at 13:00 ET. */
  earlyClose: boolean
  /** False past the end of the holiday table, where only weekend rules
   *  applied and an unlisted closure could be missed. */
  holidaysKnown: boolean
}

/** Resolve the live session state at `at`.
 *
 *  Windows are enumerated across a ±4-day band and scanned rather than
 *  reasoned about case-by-case: a long weekend, a holiday-adjacent overnight
 *  gap and an early close all fall out of the same scan, with no branch per
 *  calendar shape. */
export function marketSessionState(at: Date = new Date()): SessionState | null {
  const now = etNow(at)
  if (!now) return null
  const t = at.getTime()

  const windows: SessionWindow[] = []
  // Start a day back so an in-progress overnight window (opened yesterday
  // evening, still running past midnight) is in range.
  for (let offset = -1; offset <= 4; offset++) {
    const d = new Date(Date.UTC(now.year, now.month - 1, now.day + offset))
    windows.push(
      ...windowsForEtDate(
        d.getUTCFullYear(),
        d.getUTCMonth() + 1,
        d.getUTCDate(),
        d.getUTCDay()
      )
    )
  }
  windows.sort((a, b) => a.start - b.start)

  const current = windows.find((w) => t >= w.start && t < w.end) ?? null
  const next = windows.find((w) => w.start > t) ?? null

  return {
    current,
    next,
    msToClose: current ? current.end - t : null,
    msToOpen: next ? next.start - t : null,
    holiday: isMarketHoliday(now.year, now.month, now.day, now.weekday),
    earlyClose: EARLY_CLOSES.has(isoDate(now.year, now.month, now.day)),
    holidaysKnown: now.year <= HOLIDAY_TABLE_THROUGH_YEAR,
  }
}

/** Short badge label for a session. Matches the dashboard's existing
 *  PRE / AFT / OVN vocabulary so the countdown can sit beside that chip
 *  without introducing a second naming scheme. */
export function sessionBadge(session: MarketSession): string {
  return session === "REGULAR"
    ? "OPEN"
    : session === "PRE"
      ? "PRE"
      : session === "AFTER"
        ? "AFT"
        : "OVN"
}

/** Human name used in tooltips and prose. */
export function sessionName(session: MarketSession): string {
  return session === "REGULAR"
    ? "Regular session"
    : session === "PRE"
      ? "Pre-market"
      : session === "AFTER"
        ? "After-hours"
        : "Overnight"
}

/** Compact duration for the tile countdown: `3D 4H`, `11H`, `2H 14M`, `47M`,
 *  `<1M`. Coarsens as the span grows so the string stays short where the
 *  precision stops mattering: days drop minutes, and past ten hours so do
 *  hours — nobody reads a twelve-hour countdown to the minute, and
 *  "11H 59M" was both the longest string this can produce and the least
 *  useful place to spend the width. */
export function fmtCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "<1M"
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return "<1M"
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}D ${hours}H`
  if (hours >= 10) return `${hours}H`
  if (hours > 0) return `${hours}H ${minutes}M`
  return `${minutes}M`
}

/** ET wall-clock time of an instant, e.g. `8:00 PM ET`. Used in the
 *  countdown's tooltip so users can see the actual boundary, not just the
 *  remaining span. */
export function fmtEtSessionTime(ms: number): string {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: ET,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms)) + " ET"
  )
}
