import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

// Returns the rolling daily shielded-supply history captured by
// /api/zec-stats. Drives the historical chart on the /stats Supply tab.
//
// History accumulates one entry per UTC day on the first /api/zec-stats
// hit of that day. With no public API exposing historical Zcash
// shielded-supply data, this is the only option that doesn't require
// scraping anti-bot pages — the trade-off is that the chart starts
// empty on launch and fills out one row per day going forward.

const KV_SHIELDED_HIST_KEY = "zec.shielded.history.v1"

interface ShieldedHistoryPoint {
  date: string
  total: number
  sapling: number
  orchard: number
  sprout: number
  lockbox: number
  transparent: number
  pct: number
}

interface KVLike {
  get: (k: string) => Promise<string | null>
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

export async function GET() {
  const kv = await getKV()
  let points: ShieldedHistoryPoint[] = []
  if (kv) {
    try {
      const cached = await kv.get(KV_SHIELDED_HIST_KEY)
      if (cached) {
        const parsed = JSON.parse(cached)
        if (Array.isArray(parsed)) points = parsed as ShieldedHistoryPoint[]
      }
    } catch {
      /* fall through to empty array */
    }
  }
  return NextResponse.json(
    {
      points,
      // Friendly hint for clients: while the array fills out, the chart
      // shows a placeholder. This `daysCollected` count tells the UI
      // exactly how far along it is.
      daysCollected: points.length,
      fetchedAt: Date.now(),
    },
    {
      headers: { "Cache-Control": "public, max-age=300" },
    }
  )
}
