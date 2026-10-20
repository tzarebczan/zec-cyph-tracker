import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { putMirror } from "@/lib/kv-mirror"

// Gold spot price with a three-tier fallback chain so /what-if never
// shows a missing or stale gold figure:
//
//   1. LIVE   — pull from /api/ticker (Yahoo `GC=F`). That route has
//               its own 60s fresh + long-lived stale KV cache, so this
//               is the canonical source.
//   2. STASH  — if the ticker can't be reached or has no gold chip,
//               read this route's own KV stash. A successful live read
//               updates the stash, so this layer
//               accumulates a recent figure even when /api/ticker is
//               warm only intermittently. The stash has no TTL. Writes
//               are throttled, so the worst case is
//               "the last successful read, whenever that was".
//   3. STATIC — last-resort hardcoded $4,200/oz with a fixed asOf
//               date. Only hit when both upstream + KV are unavailable
//               (cold start in a brand-new region, KV outage, etc.).
//
// The route response includes an `asOf` field so the UI can render a
// freshness badge on the gold section: today for live, the stash
// timestamp for STASH, or the static asOf for STATIC.

const KV_STASH_KEY = "gold.lastKnown.v1"
const STATIC_FALLBACK_USD = 4200
const STATIC_FALLBACK_AS_OF = "2026-05"

interface TickerChip {
  key: string
  value: string
}
interface TickerResponse {
  chips: TickerChip[]
  fetchedAt: number
  stale?: boolean
}

interface GoldStash {
  priceUsd: number
  fetchedAt: number
}

interface GoldPriceResponse {
  priceUsd: number
  /** YYYY-MM string used by the UI as the "AS OF" badge. */
  asOf: string
  /** "live" | "stash" | "static" — exposed so the UI can hint when
   *  the figure is degraded (a stash > 24h old, for instance). */
  source: "live" | "stash" | "static"
  /** Unix-ms timestamp of when the underlying value was fetched.
   *  Lets the client compute its own freshness threshold if needed. */
  fetchedAt: number
}

interface KVLike {
  get: (key: string) => Promise<string | null>
  put: (
    key: string,
    value: string,
    options?: { expirationTtl?: number }
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

function parseTickerNumeric(value: string | undefined | null): number | null {
  if (!value) return null
  const cleaned = value.replace(/[^0-9.\-]/g, "")
  if (!cleaned) return null
  const n = parseFloat(cleaned)
  return Number.isFinite(n) && n > 0 ? n : null
}

function isoMonth(unixMs: number): string {
  // YYYY-MM, matches the format used in static-markets.json so the
  // UI's "AS OF YYYY-MM" badge renders consistently across live and
  // static sources.
  return new Date(unixMs).toISOString().slice(0, 7)
}

async function tryLiveTicker(
  request: Request
): Promise<{ priceUsd: number; fetchedAt: number } | null> {
  // Resolve /api/ticker off our own origin so this works under any
  // host (cyphzec.com, beta.cyphzec.com, preview deploys). Cache:
  // "no-store" so we get the ticker's own KV-fresh result rather
  // than a CDN-cached copy of THIS endpoint's response.
  try {
    const origin = new URL(request.url).origin
    const resp = await fetch(`${origin}/api/ticker`, { cache: "no-store" })
    if (!resp.ok) return null
    const data = (await resp.json()) as TickerResponse
    const goldChip = data.chips.find((c) => c.key === "gold")
    const price = parseTickerNumeric(goldChip?.value)
    if (price == null) return null
    return { priceUsd: price, fetchedAt: data.fetchedAt }
  } catch {
    return null
  }
}

async function readStash(kv: KVLike): Promise<GoldStash | null> {
  try {
    const raw = await kv.get(KV_STASH_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as GoldStash
    if (typeof parsed.priceUsd !== "number" || parsed.priceUsd <= 0) {
      return null
    }
    if (typeof parsed.fetchedAt !== "number") return null
    return parsed
  } catch {
    return null
  }
}

async function writeStash(kv: KVLike, stash: GoldStash): Promise<void> {
  // No TTL — the stash backs /api/ticker through an outage of any length.
  // It is a fallback, so a few minutes between writes is the same stash.
  await putMirror(kv, KV_STASH_KEY, JSON.stringify(stash))
}

export async function GET(request: Request) {
  const kv = await getKV()

  // ── 1. LIVE ────────────────────────────────────────────────────
  const live = await tryLiveTicker(request)
  if (live) {
    if (kv) {
      // Update the stash so future fallback paths have a fresh
      // baseline. Fire-and-forget; we don't gate the live response on
      // the KV write succeeding.
      void writeStash(kv, {
        priceUsd: live.priceUsd,
        fetchedAt: live.fetchedAt,
      })
    }
    const body: GoldPriceResponse = {
      priceUsd: live.priceUsd,
      asOf: isoMonth(live.fetchedAt),
      source: "live",
      fetchedAt: live.fetchedAt,
    }
    return NextResponse.json(body, {
      headers: {
        // 5min fresh + 24h stale-while-revalidate at the edge so a
        // burst of /what-if loads shares one upstream fetch.
        "Cache-Control":
          "public, max-age=300, stale-while-revalidate=86400",
      },
    })
  }

  // ── 2. STASH ────────────────────────────────────────────────────
  if (kv) {
    const stash = await readStash(kv)
    if (stash) {
      const body: GoldPriceResponse = {
        priceUsd: stash.priceUsd,
        asOf: isoMonth(stash.fetchedAt),
        source: "stash",
        fetchedAt: stash.fetchedAt,
      }
      return NextResponse.json(body, {
        // Shorter cache when we're serving from stash — we want a
        // chance to re-try the live source sooner.
        headers: {
          "Cache-Control":
            "public, max-age=60, stale-while-revalidate=3600",
        },
      })
    }
  }

  // ── 3. STATIC ──────────────────────────────────────────────────
  const body: GoldPriceResponse = {
    priceUsd: STATIC_FALLBACK_USD,
    asOf: STATIC_FALLBACK_AS_OF,
    source: "static",
    fetchedAt: 0,
  }
  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "public, max-age=60",
    },
  })
}
