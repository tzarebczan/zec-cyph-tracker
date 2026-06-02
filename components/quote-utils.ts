import type { QuoteSnapshot } from "./api-types"

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
  if (q.marketState === "REGULAR" && q.regularMarketPrice != null) {
    return q.regularMarketPrice
  }
  const candidates: { price: number; time: number }[] = []
  if (q.overnightMarketPrice != null && q.overnightMarketTime != null)
    candidates.push({
      price: q.overnightMarketPrice,
      time: q.overnightMarketTime,
    })
  if (q.postMarketPrice != null && q.postMarketTime != null)
    candidates.push({ price: q.postMarketPrice, time: q.postMarketTime })
  if (q.preMarketPrice != null && q.preMarketTime != null)
    candidates.push({ price: q.preMarketPrice, time: q.preMarketTime })
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
   *  Pulled from `regularMarketPreviousClose` in extended hours, or
   *  `regularMarketPrice` during the regular session itself. */
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

  if (q.marketState === "REGULAR" && q.regularMarketPrice != null) {
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
  const candidates: Cand[] = []
  if (q.overnightMarketPrice != null && q.overnightMarketTime != null) {
    candidates.push({
      session: "OVN",
      price: q.overnightMarketPrice,
      time: q.overnightMarketTime,
      change: q.overnightMarketChange,
      changePct: q.overnightMarketChangePercent,
    })
  }
  if (q.postMarketPrice != null && q.postMarketTime != null) {
    candidates.push({
      session: "POST",
      price: q.postMarketPrice,
      time: q.postMarketTime,
      change: q.postMarketChange,
      changePct: q.postMarketChangePercent,
    })
  }
  if (q.preMarketPrice != null && q.preMarketTime != null) {
    candidates.push({
      session: "PRE",
      price: q.preMarketPrice,
      time: q.preMarketTime,
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
      prevClose: q.regularMarketPreviousClose ?? q.regularMarketPrice,
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
