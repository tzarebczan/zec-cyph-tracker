import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

// Daily ZEC transaction counts for the ZEC stats Transactions tab.
//
// The previous zecstats.com feed stopped at 2023-09-05, which made the
// mobile chart look like it was showing future MM-DD dates. The current
// source pair below keeps the chart on completed UTC days:
//   - Coin Metrics Community API: total daily ZEC TxCnt.
//   - CipherScan mainnet API: daily shielded transaction count.
//
// Cache layout:
//   - 6h fresh KV cache; both upstreams are daily/near-daily series.
//   - Long-lived stale mirror, written on every successful fetch.
//   - CDN cache headers so the Worker/API route is not hit repeatedly
//     between KV refreshes.

const COINMETRICS_URL =
  "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics"
const CIPHERSCAN_SHIELDED_URL =
  "https://api.mainnet.cipherscan.app/api/stats/shielded-daily"

const KV_KEY = "zec.tx-stats.v3"
const KV_TTL_SECONDS = 6 * 60 * 60
const KV_STALE_KEY = "zec.tx-stats.stale.v3"

// Cap the returned series at ~3 years of daily points. That preserves
// the existing ALL window without shipping full-chain history.
const MAX_DAYS = 365 * 3
const DAY_MS = 86_400_000

const RESPONSE_HEADERS = {
  "Cache-Control":
    "public, max-age=300, s-maxage=21600, stale-while-revalidate=43200",
}

const HEADERS = {
  "User-Agent":
    "cyphzec.com tx-stats cache (+https://cyphzec.com/stats)",
  Accept: "application/json",
}

interface KVLike {
  get: (k: string) => Promise<string | null>
  put: (
    k: string,
    v: string,
    o?: { expirationTtl?: number }
  ) => Promise<void>
}

async function getKV(): Promise<KVLike | null> {
  try {
    const ctx = await getCloudflareContext({ async: true })
    return (
      (ctx?.env as { SUPPLY_CACHE?: KVLike } | undefined)?.SUPPLY_CACHE ?? null
    )
  } catch {
    return null
  }
}

interface CoinMetricsRow {
  asset?: string
  time?: string
  TxCnt?: string
}

interface CoinMetricsResponse {
  data?: CoinMetricsRow[]
}

interface CipherScanDailyRow {
  date?: string
  count?: number
}

interface CipherScanShieldedResponse {
  success?: boolean
  daily?: CipherScanDailyRow[]
}

interface TxDay {
  date: string
  /** Daily total tx count from Coin Metrics TxCnt. */
  total: number
  /** Derived non-shielded count for legacy chart shape. */
  transparentOnly: number
  /** Txs that ENTER a shielded pool (not split by CipherScan). */
  shielding: number
  /** Txs that EXIT a shielded pool (not split by CipherScan). */
  deshielding: number
  /** All shielded-touching txs from CipherScan daily count. */
  fullyShielded: number
  /** Mixed txs are included in the shielded daily count above. */
  mixed: number
}

interface TxStatsResponse {
  /** Daily series, oldest first. Use slice(-N) on the client to
   *  window it without touching the server. */
  days: TxDay[]
  latestDate: string | null
  dataLagDays: number | null
  source: {
    total: string
    shielded: string
  }
  /** Server timestamp the upstreams were last successfully fetched. */
  fetchedAt: number
  /** True when served from the long-lived stale mirror because the
   *  upstream is unavailable. */
  stale?: boolean
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function completedWindow() {
  const todayMs = Date.parse(`${utcDate(Date.now())}T00:00:00Z`)
  return {
    start: utcDate(todayMs - MAX_DAYS * DAY_MS),
    coinMetricsEnd: utcDate(todayMs - DAY_MS),
    cipherScanUntil: utcDate(todayMs),
    today: utcDate(todayMs),
  }
}

function asDate(value: string | undefined): string | null {
  if (!value) return null
  const date = value.includes("T") ? value.slice(0, 10) : value
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
}

function asCount(value: string | number | undefined): number | null {
  const n = typeof value === "string" ? Number(value) : value
  return Number.isFinite(n) && n != null ? Math.max(0, Math.round(n)) : null
}

async function fetchCoinMetricsTotals(
  start: string,
  end: string
): Promise<Map<string, number>> {
  const url = new URL(COINMETRICS_URL)
  url.searchParams.set("assets", "zec")
  url.searchParams.set("metrics", "TxCnt")
  url.searchParams.set("frequency", "1d")
  url.searchParams.set("start_time", start)
  url.searchParams.set("end_time", end)
  url.searchParams.set("page_size", "10000")

  const res = await fetch(url, {
    headers: HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`Coin Metrics tx count failed: ${res.status}`)
  }
  const json = (await res.json()) as CoinMetricsResponse
  const out = new Map<string, number>()
  for (const row of json.data ?? []) {
    const date = asDate(row.time)
    const count = asCount(row.TxCnt)
    if (date && count != null) out.set(date, count)
  }
  return out
}

async function fetchCipherScanShielded(
  start: string,
  untilExclusive: string
): Promise<Map<string, number>> {
  const url = new URL(CIPHERSCAN_SHIELDED_URL)
  url.searchParams.set("since", start)
  url.searchParams.set("until", untilExclusive)

  const res = await fetch(url, {
    headers: HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  })
  if (!res.ok) {
    throw new Error(`CipherScan shielded tx count failed: ${res.status}`)
  }
  const json = (await res.json()) as CipherScanShieldedResponse
  if (json.success === false) {
    throw new Error("CipherScan shielded tx count was unsuccessful")
  }
  const out = new Map<string, number>()
  for (const row of json.daily ?? []) {
    const date = asDate(row.date)
    const count = asCount(row.count)
    if (date && count != null) out.set(date, count)
  }
  return out
}

function buildDays(
  totals: Map<string, number>,
  shieldedCounts: Map<string, number>,
  today: string
): TxDay[] {
  const days: TxDay[] = []
  for (const [date, total] of totals) {
    if (date > today) continue
    const shielded = Math.min(shieldedCounts.get(date) ?? 0, total)
    days.push({
      date,
      total,
      transparentOnly: Math.max(0, total - shielded),
      shielding: 0,
      deshielding: 0,
      fullyShielded: shielded,
      mixed: 0,
    })
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return days.length > MAX_DAYS ? days.slice(-MAX_DAYS) : days
}

function dataLagDays(days: TxDay[]): number | null {
  const latest = days.at(-1)?.date
  if (!latest) return null
  const latestMs = Date.parse(`${latest}T00:00:00Z`)
  const todayMs = Date.parse(`${utcDate(Date.now())}T00:00:00Z`)
  if (!Number.isFinite(latestMs) || !Number.isFinite(todayMs)) return null
  return Math.max(0, Math.floor((todayMs - latestMs) / DAY_MS))
}

function makePayload(days: TxDay[]): TxStatsResponse {
  return {
    days,
    latestDate: days.at(-1)?.date ?? null,
    dataLagDays: dataLagDays(days),
    source: {
      total: "Coin Metrics Community API TxCnt",
      shielded: "CipherScan mainnet shielded-daily",
    },
    fetchedAt: Date.now(),
  }
}

export async function GET() {
  const kv = await getKV()

  // 1) Fresh KV cache hit.
  if (kv) {
    try {
      const cached = await kv.get(KV_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as TxStatsResponse
        if (Array.isArray(parsed.days) && parsed.days.length > 0) {
          return NextResponse.json(parsed, { headers: RESPONSE_HEADERS })
        }
      }
    } catch {
      /* fall through */
    }
  }

  // 2) Hit the upstreams.
  let days: TxDay[] | null = null
  try {
    const { start, coinMetricsEnd, cipherScanUntil, today } = completedWindow()
    const [totals, shieldedCounts] = await Promise.all([
      fetchCoinMetricsTotals(start, coinMetricsEnd),
      fetchCipherScanShielded(start, cipherScanUntil),
    ])
    days = buildDays(totals, shieldedCounts, today)
  } catch {
    /* fall through to stale */
  }

  if (days && days.length > 0) {
    const payload = makePayload(days)
    if (kv) {
      const json = JSON.stringify(payload)
      try {
        await Promise.all([
          kv.put(KV_KEY, json, { expirationTtl: KV_TTL_SECONDS }),
          kv.put(KV_STALE_KEY, json),
        ])
      } catch {}
    }
    return NextResponse.json(payload, { headers: RESPONSE_HEADERS })
  }

  // 3) Stale mirror - upstream blip. Daily stats move slowly; even a
  //    multi-day-old payload is informative.
  if (kv) {
    try {
      const stale = await kv.get(KV_STALE_KEY)
      if (stale) {
        const parsed = JSON.parse(stale) as TxStatsResponse
        if (Array.isArray(parsed.days) && parsed.days.length > 0) {
          return NextResponse.json(
            { ...parsed, stale: true },
            { headers: RESPONSE_HEADERS }
          )
        }
      }
    } catch {
      /* fall through to error */
    }
  }

  return NextResponse.json(
    { error: "ZEC tx-stats upstream unavailable" },
    { status: 502 }
  )
}
