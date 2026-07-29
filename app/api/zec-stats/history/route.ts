import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

// Historical Zcash shielded-pool supply for the /stats Supply tab chart.
//
// Source: zecprice.com publishes a static `shielded-pool-data.json`
// regenerated ~daily, sampled every 576 blocks (~12h). Each point has
// sprout / sapling / orchard / ironwood pool sizes plus the running total. We
// decimate that to one point per UTC day (the day's latest reading
// wins) so the payload sent to clients stays under ~100KB while
// covering the full ~10-year history of shielded supply.
//
// Cache: 24h in Workers KV. Source updates daily, so a longer TTL
// just means a one-day lag at most. If the upstream fetch fails we
// fall back to whatever the previous good payload was; if KV is
// also empty we return an empty array so the UI's "history
// accumulating" placeholder shows instead of a hard error.

const ZECPRICE_URL = "https://zecprice.com/shielded-pool-data.json"
// v3 adds the Ironwood `ir` series now published by zecprice.
const KV_KEY = "zec.shielded.history.v3"
const KV_TTL = 24 * 60 * 60 // 24h

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

interface ZecpriceRawPoint {
  t: number // unix seconds
  h: number // block height
  sp: number // sprout
  sa: number // sapling
  or: number // orchard
  ir?: number // ironwood (NU6.3+; absent from older source snapshots)
  v: number // total shielded
}
interface ZecpriceFile {
  meta?: {
    generatedAt?: string
    endTime?: number
  }
  data?: ZecpriceRawPoint[]
}

interface ShieldedHistoryPoint {
  date: string // YYYY-MM-DD UTC
  total: number
  sapling: number
  orchard: number
  ironwood: number
  sprout: number
  // zecprice doesn't track NU6.1 lockbox or transparent supply, but
  // we keep these fields populated with 0 so the client chart shape
  // stays uniform with the realtime /api/zec-stats payload.
  lockbox: number
  transparent: number
  pct: number
}

interface CachedPayload {
  points: ShieldedHistoryPoint[]
  fetchedAt: number
  generatedAt: string | null
}

/** Decimate the 12h-cadence series to one point per UTC day. We keep
 *  the day's latest reading because the file is appended chronologically
 *  and the most recent sample best reflects "the day's supply". */
function decimateToDaily(raw: ZecpriceRawPoint[]): ShieldedHistoryPoint[] {
  const byDay = new Map<string, ZecpriceRawPoint>()
  for (const p of raw) {
    const date = new Date(p.t * 1000).toISOString().slice(0, 10)
    const prev = byDay.get(date)
    if (!prev || p.t > prev.t) byDay.set(date, p)
  }
  // toSorted on an iterable: spread once, sort immutably. byDay.entries()
  // returns a fresh iterator each call, so this doesn't mutate the Map.
  const sorted = Array.from(byDay.entries()).toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )
  return sorted.map(([date, p]) => ({
    date,
    total: p.v,
    sapling: p.sa,
    orchard: p.or,
    ironwood: p.ir ?? 0,
    sprout: p.sp,
    lockbox: 0,
    transparent: 0,
    // pct of total chain supply isn't computable from this dataset
    // alone (we'd need historical circulating-supply per day too),
    // so leave at 0. The realtime /api/zec-stats payload carries the
    // current pct and the chart only needs total for the line.
    pct: 0,
  }))
}

export async function GET() {
  const kv = await getKV()

  // 1) KV hit
  if (kv) {
    try {
      const cached = await kv.get(KV_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as CachedPayload
        if (Array.isArray(parsed.points) && parsed.points.length > 0) {
          return NextResponse.json(
            {
              points: parsed.points,
              daysCollected: parsed.points.length,
              generatedAt: parsed.generatedAt,
              fetchedAt: parsed.fetchedAt,
              source: "zecprice.com",
            },
            { headers: { "Cache-Control": "public, max-age=300" } }
          )
        }
      }
    } catch {
      /* fall through and refetch */
    }
  }

  // 2) Pull fresh from zecprice.com. The static JSON is CDN-served and
  //    typically returns fast, but we tighten the timeout so a hung
  //    upstream doesn't block route-level requests for too long.
  let payload: CachedPayload | null = null
  try {
    const res = await fetch(ZECPRICE_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "application/json",
      },
    })
    if (res.ok) {
      const file = (await res.json()) as ZecpriceFile
      const raw = file.data ?? []
      if (raw.length > 0) {
        const points = decimateToDaily(raw)
        payload = {
          points,
          generatedAt: file.meta?.generatedAt ?? null,
          fetchedAt: Date.now(),
        }
        if (kv) {
          try {
            await kv.put(KV_KEY, JSON.stringify(payload), {
              expirationTtl: KV_TTL,
            })
          } catch {
            /* best-effort */
          }
        }
      }
    }
  } catch {
    /* try the empty-fallback below */
  }

  if (!payload) {
    return NextResponse.json(
      {
        points: [],
        daysCollected: 0,
        generatedAt: null,
        fetchedAt: Date.now(),
        source: null,
      },
      { headers: { "Cache-Control": "public, max-age=60" } }
    )
  }

  return NextResponse.json(
    {
      points: payload.points,
      daysCollected: payload.points.length,
      generatedAt: payload.generatedAt,
      fetchedAt: payload.fetchedAt,
      source: "zecprice.com",
    },
    { headers: { "Cache-Control": "public, max-age=300" } }
  )
}
