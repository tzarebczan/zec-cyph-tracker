// Single source of truth for everything we read off cypherpunk.com.
//
// The August 2026 site revamp removed the public Payload endpoints we used to
// call: `/api/transactions` now 404s and its replacement collection,
// `/api/treasury-transactions`, is access-controlled (403 for anonymous
// callers). What survives is the homepage itself, whose React Server Component
// payload embeds the whole dashboard dataset — the live computed metrics, the
// full treasury transaction list, and the CMS methodology copy.
//
// Two distinct metric blocks live in that payload and they disagree:
//
//   1. a computed object — enterpriseValue 216588296.31, mnav 1.0600,
//      fullyDilutedShares 333338381 — which moves with the share price and is
//      internally consistent (EV / NAV reproduces mnav exactly), and
//   2. a CMS global (`globalType: "dashboard-metrics"`) of hand-entered display
//      strings — enterpriseValue "$$167.96M" (note the doubled `$`), mnav
//      "1.47", fullyDilutedShares "326.20M" — stale by tens of percent.
//
// The previous scraper matched on the CMS block's `"value"` strings, so it was
// serving stale figures even before the slug it keyed off disappeared. We read
// the computed object instead.

export const CYPHERPUNK_SITE_URL = "https://www.cypherpunk.com/"

/** Browser-ish UA. The site 403s some default agents. */
const SITE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
}

export interface CypherpunkTreasuryTx {
  /** "ZEC", "MINING", "ZODL" — a plain string now; it used to be a relation
   *  with `{ name, symbol }`. */
  asset: string
  type: "buy" | "sell"
  /** Null for non-unit assets like MINING and ZODL, which disclose only a
   *  dollar amount. */
  amount: number | null
  unitPrice: number | null
  totalValue: number | null
  date: string
}

export interface CypherpunkMetrics {
  enterpriseValue: number | null
  debt: number | null
  fullyDilutedShares: number | null
  commonPrefundedWarrants: number | null
  marketCapitalization: number | null
  netAssetValue: number | null
  mnav: number | null
  zecHoldings: number | null
  zecAvgBuyPrice: number | null
  /** Total non-ZEC investment at cost — mining plus other stakes. */
  investmentsAtCost: number | null
  zecNetworkPercent: number | null
  zcashNetworkGoal: number | null
}

export interface CypherpunkSiteData {
  metrics: CypherpunkMetrics
  treasuryTxns: CypherpunkTreasuryTx[]
}

/** Reassemble the streamed RSC payload. Next pushes it as a series of
 *  `self.__next_f.push([1,"<json-encoded chunk>"])` calls, so each chunk needs
 *  JSON-decoding before the pieces are concatenated. */
export function extractFlightPayload(html: string): string {
  const pushes = html.matchAll(
    /self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g
  )
  let flight = ""
  for (const match of pushes) {
    try {
      flight += JSON.parse(match[1]) as string
    } catch {
      // A single malformed chunk shouldn't lose the rest of the payload.
    }
  }
  // Fall back to a crude unescape if the streaming shape ever changes; the
  // field regexes below still work against it.
  if (!flight) flight = html.replace(/\\"/g, '"')
  return flight
}

/** Pull a bare numeric field. Deliberately requires a digit or sign directly
 *  after the colon, which is what disambiguates the live computed values from
 *  the CMS block — there, the same keys are followed by `{"value":"..."}`. */
function numericField(flight: string, key: string): number | null {
  const pattern = new RegExp(
    `"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`
  )
  const match = flight.match(pattern)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/** Balanced-bracket slice for the treasuryTxns array. A plain regex can't be
 *  trusted here because the array contains nested objects and quoted strings. */
function jsonArrayAfter(flight: string, key: string): unknown[] | null {
  const keyIndex = flight.indexOf(`"${key}"`)
  if (keyIndex < 0) return null
  const open = flight.indexOf("[", keyIndex)
  if (open < 0) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = open; i < flight.length; i++) {
    const ch = flight[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "[") depth++
    else if (ch === "]") {
      depth--
      if (depth === 0) {
        try {
          const parsed = JSON.parse(flight.slice(open, i + 1))
          return Array.isArray(parsed) ? parsed : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function parseCypherpunkSite(html: string): CypherpunkSiteData {
  const flight = extractFlightPayload(html)

  const metrics: CypherpunkMetrics = {
    enterpriseValue: numericField(flight, "enterpriseValue"),
    debt: numericField(flight, "debt"),
    fullyDilutedShares: numericField(flight, "fullyDilutedShares"),
    commonPrefundedWarrants: numericField(flight, "commonPrefundedWarrants"),
    marketCapitalization: numericField(flight, "marketCapitalization"),
    netAssetValue: numericField(flight, "netAssetValue"),
    mnav: numericField(flight, "mnav"),
    zecHoldings: numericField(flight, "zecHoldings"),
    zecAvgBuyPrice: numericField(flight, "zecAvgBuyPrice"),
    investmentsAtCost: numericField(flight, "investmentsAtCost"),
    zecNetworkPercent: numericField(flight, "zecNetworkPercent"),
    zcashNetworkGoal: numericField(flight, "zcashNetworkGoal"),
  }

  const rawTxns = jsonArrayAfter(flight, "treasuryTxns") ?? []
  const treasuryTxns: CypherpunkTreasuryTx[] = rawTxns
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .map((row) => ({
      asset: typeof row.asset === "string" ? row.asset.toUpperCase() : "",
      type: row.type === "sell" ? ("sell" as const) : ("buy" as const),
      amount: finiteOrNull(row.amount),
      unitPrice: finiteOrNull(row.unitPrice),
      totalValue: finiteOrNull(row.totalValue),
      date: typeof row.date === "string" ? row.date : "",
    }))
    .filter((tx) => tx.asset !== "" && tx.date !== "")

  return { metrics, treasuryTxns }
}

export async function fetchCypherpunkSite(): Promise<CypherpunkSiteData> {
  const res = await fetch(CYPHERPUNK_SITE_URL, {
    headers: SITE_HEADERS,
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`cypherpunk.com HTTP ${res.status}`)
  const data = parseCypherpunkSite(await res.text())
  // A shape change upstream should surface as an error rather than silently
  // reporting an empty treasury.
  if (!data.treasuryTxns.length && data.metrics.netAssetValue == null) {
    throw new Error("cypherpunk.com payload contained no recognisable data")
  }
  return data
}

/* ── Mining ───────────────────────────────────────────────────────────
   Cypherpunk announced Cypherpunk Mining on 2026-08-18 and it appears in the
   treasury list as a single `MINING` buy with a dollar amount and no units.
   They publish no hashrate, no MW, no fleet size and no ZEC-mined figure —
   not on the site, not in the CMS, and not in the launch post (whose body is
   empty and links out to X). So dollars invested and time-since-launch are the
   only mining facts we can state; anything per-day would be invented. */

export interface CypherpunkMining {
  /** Disclosed capital deployed into mining, at cost. */
  investedUSD: number
  /** First disclosed mining outlay — treated as the go-live date. */
  startedAt: string
  /** Distinct mining outlays disclosed so far. */
  outlays: number
}

export function extractMining(
  txns: CypherpunkTreasuryTx[]
): CypherpunkMining | null {
  const mining = txns.filter(
    (tx) => tx.asset === "MINING" && tx.type === "buy"
  )
  if (!mining.length) return null
  const investedUSD = mining.reduce((sum, tx) => sum + (tx.totalValue ?? 0), 0)
  const startedAt = mining
    .map((tx) => tx.date)
    .sort()[0]
  return { investedUSD, startedAt, outlays: mining.length }
}
