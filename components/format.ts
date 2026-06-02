// Shared formatters used across the beta redesign. Matches the
// language used by the legacy components (price-dashboard.tsx,
// stat-card.tsx) so numbers read consistently no matter which
// surface the user is on.

export function fmtUSD(n: number | null | undefined, opts: { maxFrac?: number; minFrac?: number } = {}): string {
  if (n == null || !Number.isFinite(n)) return "—"
  const { maxFrac = 2, minFrac = 2 } = opts
  if (n < 1 && n > 0) return "$" + n.toFixed(4)
  return (
    "$" +
    n.toLocaleString("en-US", {
      minimumFractionDigits: minFrac,
      maximumFractionDigits: maxFrac,
    })
  )
}

export function fmtCompactUSD(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  const abs = Math.abs(n)
  if (abs >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T"
  if (abs >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B"
  if (abs >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M"
  if (abs >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K"
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 })
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return (n >= 0 ? "+" : "") + n.toFixed(digits) + "%"
}

export function fmtRatio(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  if (n < 0.001) return n.toExponential(3)
  return n.toPrecision(4)
}

/**
 * Compact USD formatter for table cells where width is tight.
 *  - n >= 1e3 -> "$X.YYK" / "$X.YYM" / "$X.YYB" — same K/M/B suffix
 *    as `fmtCompactUSD`, but always two decimals so column widths
 *    stay predictable.
 *  - 1 <= n < 1e3 -> two-decimal plain dollars ("$614.06").
 *  - 0 < n < 1 -> four-decimal plain dollars ("$0.0123") so small
 *    crypto prices stay legible.
 *
 *  Distinct from `fmtCompactUSD` (which truncates < 1000 to whole
 *  dollars) because rankings rows show small-cap prices alongside
 *  large ones and need both readable.
 */
export function fmtPriceCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  const abs = Math.abs(n)
  if (abs >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B"
  if (abs >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M"
  if (abs >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K"
  if (abs >= 1) return "$" + n.toFixed(2)
  return "$" + n.toFixed(4)
}

export function fmtCompactNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  const abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B"
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M"
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + "K"
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 })
}

/** Format a unix-seconds timestamp as a short clock in the New York
 *  trading-day frame, e.g. "Tue 4:00 PM ET" or "9:30 AM ET" depending
 *  on `withDayPrefix`. Used by the CYPH tile to label the last regular
 *  close + the active extended-hours session timestamp so users can
 *  see how stale a price is without doing TZ math in their head.
 *
 *  Returns `"—"` for nullish / non-finite input rather than throwing,
 *  so callers can pass through whatever Yahoo gave them. */
export function fmtEtClock(
  unixSec: number | null | undefined,
  opts: { withDayPrefix?: boolean } = {}
): string {
  if (unixSec == null || !Number.isFinite(unixSec)) return "—"
  const { withDayPrefix = false } = opts
  const d = new Date(unixSec * 1000)
  try {
    const time = d.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    })
    if (!withDayPrefix) return `${time} ET`
    const day = d.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
    })
    return `${day} ${time} ET`
  } catch {
    return "—"
  }
}

/** Render a CoinGecko-style trading pair label with overflow-prone
 *  pieces shortened. Some ZEC pairs come back from CG looking like
 *
 *      ETH-0XDAC17F958D2EE523A2206206994597C13D831EC7.OMFT.NEAR/ZEC.OMFT.NEAR
 *
 *  i.e. a base symbol prefix, an EVM contract address (40 hex chars),
 *  and a NEAR-Intents `.OMFT.NEAR` suffix. Rendered raw, that single
 *  string is 70+ chars and blows out every cell that hosts it
 *  (top-pairs grid, treemap label, dashboard chips). This helper:
 *    - Strips trailing `.OMFT.NEAR` (and any `.NEAR` suffix on the
 *      base side) from each side of the slash.
 *    - Collapses any `0X[A-F0-9]{40}` contract address to a `0X1234…
 *      ABCD` truncation that still uniquely identifies the contract
 *      to anyone who'd recognise it.
 *    - Leaves "ordinary" pairs (`ZEC/USDT`, `ZEC/BTC`, …) unchanged.
 *
 *  The full string is still useful for tooltips, so callers should
 *  pass `pair` to a `title` attribute and `prettyPair(pair)` to the
 *  visible content. */
export function prettyPair(pair: string): string {
  if (!pair) return pair
  const sides = pair.split("/")
  const cleaned = sides.map((side) => {
    let out = side
    // Drop NEAR-Intents wrapping suffix, both `.OMFT.NEAR` and a bare
    // `.NEAR` left behind on simple wraps. Case-insensitive because
    // CG sometimes uppercases the lot.
    out = out.replace(/\.OMFT\.NEAR$/i, "")
    out = out.replace(/\.NEAR$/i, "")
    // Compress full-length EVM contract addresses inline.
    out = out.replace(
      /0X[A-F0-9]{40}/gi,
      (m) => `${m.slice(0, 6)}…${m.slice(-4)}`
    )
    return out
  })
  return cleaned.join("/")
}

// SWR fetcher that surfaces server-side JSON errors as thrown
// exceptions so SWR can retry / fall back correctly. Mirrors the
// pattern used in the main site's PriceDashboard.
export const swrFetcher = async (url: string) => {
  const res = await fetch(url)
  const json = await res.json()
  if (!res.ok || (json && typeof json === "object" && "error" in json)) {
    throw new Error(json?.error ?? `Request failed: ${res.status}`)
  }
  return json
}
