import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

// Daily ZEC transaction-mix series — used by the Supply tab's
// Transactions chart. Source is zecstats.com/api/daily-stats, a
// public endpoint maintained by community researchers that pulls
// from a node and exposes per-day tx-type counts (transparent-only,
// shielding, deshielding, fully-shielded, mixed). We slice down to
// just the fields we need and ship at most ~3 years of daily data so
// the response stays under a few hundred KB.
//
// Cache layout:
//   - 6h fresh KV cache (the upstream regenerates ~daily so anything
//     finer is wasted round-trips).
//   - Long-lived stale mirror, no TTL, written on every successful
//     fetch. When zecstats.com is unreachable past the 6h window we
//     serve last-known-good rather than blanking the chart.

const UPSTREAM_URL = "https://zecstats.com/api/daily-stats"

const KV_KEY = "zec.tx-stats.v1"
const KV_TTL_SECONDS = 6 * 60 * 60 // 6h — upstream regenerates ~daily
const KV_STALE_KEY = "zec.tx-stats.stale.v1"

// Cap the returned series at ~3 years of daily points. Plenty of
// history for the 1Y / 3Y / All window selectors on the chart, far
// short of the full 3490-row payload that would bloat the response.
const MAX_DAYS = 365 * 3

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
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

interface RawDailyRow {
  date?: string
  tx_count?: number
  tx_transparent_only?: number
  tx_shielding?: number
  tx_deshielding?: number
  tx_fully_shielded?: number
  tx_mixed?: number
  shielded_tx_count?: number
}

interface TxDay {
  date: string
  /** Daily total tx count (sum of the buckets below). */
  total: number
  /** Purely transparent txs (no shielded touch). */
  transparentOnly: number
  /** Txs that ENTER a shielded pool (T → Z). */
  shielding: number
  /** Txs that EXIT a shielded pool (Z → T). */
  deshielding: number
  /** Fully shielded txs (Z → Z). */
  fullyShielded: number
  /** Mixed txs (touches multiple pool types). */
  mixed: number
}

interface TxStatsResponse {
  /** Daily series, oldest first. Use slice(-N) on the client to
   *  window it without touching the server. */
  days: TxDay[]
  /** Server timestamp the upstream was last successfully fetched. */
  fetchedAt: number
  /** True when served from the long-lived stale mirror because the
   *  upstream is unavailable. */
  stale?: boolean
}

function normalize(rows: RawDailyRow[]): TxDay[] {
  const out: TxDay[] = []
  for (const r of rows) {
    if (!r?.date) continue
    const transparentOnly = r.tx_transparent_only ?? 0
    const shielding = r.tx_shielding ?? 0
    const deshielding = r.tx_deshielding ?? 0
    const fullyShielded = r.tx_fully_shielded ?? 0
    const mixed = r.tx_mixed ?? 0
    // Prefer the upstream's own tx_count when it's available — it's
    // sourced directly from the block data, so it'll match block
    // explorers exactly. Fall back to the sum of the buckets when
    // tx_count is missing.
    const total =
      r.tx_count != null
        ? r.tx_count
        : transparentOnly + shielding + deshielding + fullyShielded + mixed
    out.push({
      date: r.date,
      total,
      transparentOnly,
      shielding,
      deshielding,
      fullyShielded,
      mixed,
    })
  }
  // Sort ascending by date so consumers can slice(-N) for "last N
  // days" without an additional sort. ISO yyyy-mm-dd dates sort
  // lexicographically, so a string compare is fine.
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  // Trim to the rolling window. The upstream returns the full ~9-year
  // history; we don't need it all and shipping 3MB to every chart
  // client is silly.
  if (out.length > MAX_DAYS) return out.slice(-MAX_DAYS)
  return out
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
          return NextResponse.json(parsed, {
            headers: { "Cache-Control": "public, max-age=300" },
          })
        }
      }
    } catch {
      /* fall through */
    }
  }

  // 2) Hit the upstream.
  let days: TxDay[] | null = null
  try {
    const res = await fetch(UPSTREAM_URL, {
      headers: HEADERS,
      cache: "no-store",
      // The 3MB payload arrives in ~1–2s normally; cap to 12s so a
      // stuck upstream doesn't drag the whole route response time
      // down with it. Stale mirror catches the timeout case.
      signal: AbortSignal.timeout(12_000),
    })
    if (res.ok) {
      const json = (await res.json()) as RawDailyRow[]
      if (Array.isArray(json) && json.length > 0) {
        days = normalize(json)
      }
    }
  } catch {
    /* fall through to stale */
  }

  if (days && days.length > 0) {
    const payload: TxStatsResponse = { days, fetchedAt: Date.now() }
    if (kv) {
      const json = JSON.stringify(payload)
      try {
        // Two writes: short-TTL fresh cache + no-TTL stale mirror.
        await Promise.all([
          kv.put(KV_KEY, json, { expirationTtl: KV_TTL_SECONDS }),
          kv.put(KV_STALE_KEY, json),
        ])
      } catch {}
    }
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, max-age=300" },
    })
  }

  // 3) Stale mirror — upstream blip. Daily stats move slowly; even a
  //    multi-day-old payload is informative.
  if (kv) {
    try {
      const stale = await kv.get(KV_STALE_KEY)
      if (stale) {
        const parsed = JSON.parse(stale) as TxStatsResponse
        if (Array.isArray(parsed.days) && parsed.days.length > 0) {
          return NextResponse.json(
            { ...parsed, stale: true },
            { headers: { "Cache-Control": "public, max-age=300" } }
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
