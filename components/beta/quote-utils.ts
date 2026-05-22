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
