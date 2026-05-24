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
