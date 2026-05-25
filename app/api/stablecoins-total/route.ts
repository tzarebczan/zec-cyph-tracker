import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

// Total stablecoin market cap, sourced from DefiLlama's canonical
// stablecoin tracker. We previously summed the top issuers (USDT +
// USDC + DAI + …) off our own /api/markets route, which under-counted
// by ~$50B because it missed PYUSD / USDS / USDP / smaller issuers.
//
// DefiLlama publishes the totals at
// https://stablecoins.llama.fi/stablecoincharts/all — a flat array
// of `{ date, totalCirculating: { peggedUSD } }` chart points
// covering the whole stablecoin universe (pegged-to-USD totals are
// the relevant figure for the /what-if math; their EUR/GBP pegs are
// tracked separately and dwarfed by USD ones).
//
// Three-tier fallback chain so /what-if's stablecoin section never
// shows a missing or stale figure:
//   1. KV FRESH   — 1h TTL. Stablecoin totals move ~<1%/hour so
//                   the user-visible refresh cadence here is fine
//                   at hourly; DefiLlama itself updates daily.
//   2. KV STASH   — long-lived "last known good" so we survive a
//                   DefiLlama outage. Overwritten on every success.
//   3. UPSTREAM   — direct DefiLlama fetch if KV is cold.
//
// If everything fails we return 503 so the client can fall back to
// the legacy CMC-sum computation as a safety net.

const DEFILLAMA_URL = "https://stablecoins.llama.fi/stablecoincharts/all"

const KV_FRESH_KEY = "stablecoins.total.v1"
const KV_FRESH_TTL_SEC = 60 * 60 // 1 hour
const KV_STASH_KEY = "stablecoins.total.lastKnown.v1"

interface StablecoinTotalResponse {
  /** Sum of USD-pegged stablecoin circulating supplies. */
  totalUsd: number
  /** YYYY-MM-DD of the DefiLlama snapshot the totalUsd was taken from. */
  asOfDate: string
  /** YYYY-MM convenience field for the UI's "AS OF" badge. */
  asOf: string
  source: "defillama" | "stash"
  fetchedAt: number
}

// DefiLlama field types — kept loose because the API has shifted
// between `totalCirculating` and `totalCirculatingUSD` historically;
// we accept either and fail soft otherwise.
interface DefiLlamaChartPoint {
  date: string | number
  totalCirculating?: { peggedUSD?: number }
  totalCirculatingUSD?: { peggedUSD?: number }
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

function isoMonth(unixMs: number): string {
  return new Date(unixMs).toISOString().slice(0, 7)
}

function isoDate(unixMs: number): string {
  return new Date(unixMs).toISOString().slice(0, 10)
}

async function tryDefiLlama(): Promise<{
  totalUsd: number
  dateMs: number
} | null> {
  try {
    const resp = await fetch(DEFILLAMA_URL, {
      headers: { Accept: "application/json" },
      // No special CF init — the asset is small enough (~few KB) that
      // a vanilla fetch with default caching is fine.
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as DefiLlamaChartPoint[]
    if (!Array.isArray(data) || data.length === 0) return null
    const last = data[data.length - 1]
    const total =
      last.totalCirculating?.peggedUSD ??
      last.totalCirculatingUSD?.peggedUSD ??
      null
    if (total == null || !Number.isFinite(total) || total <= 0) return null
    // `date` is a unix-second timestamp; coerce to number defensively
    // in case the upstream returns it as a string.
    const dateSec =
      typeof last.date === "number" ? last.date : parseInt(String(last.date))
    const dateMs = Number.isFinite(dateSec) ? dateSec * 1000 : Date.now()
    return { totalUsd: total, dateMs }
  } catch {
    return null
  }
}

async function readKvFresh(
  kv: KVLike
): Promise<StablecoinTotalResponse | null> {
  try {
    const raw = await kv.get(KV_FRESH_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StablecoinTotalResponse
    if (Date.now() - parsed.fetchedAt < KV_FRESH_TTL_SEC * 1000) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

async function readKvStash(
  kv: KVLike
): Promise<StablecoinTotalResponse | null> {
  try {
    const raw = await kv.get(KV_STASH_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StablecoinTotalResponse
    if (typeof parsed.totalUsd === "number" && parsed.totalUsd > 0) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

async function writeKv(
  kv: KVLike,
  body: StablecoinTotalResponse
): Promise<void> {
  await kv
    .put(KV_FRESH_KEY, JSON.stringify(body), {
      expirationTtl: KV_FRESH_TTL_SEC,
    })
    .catch(() => {
      /* best-effort */
    })
  await kv.put(KV_STASH_KEY, JSON.stringify(body)).catch(() => {
    /* best-effort */
  })
}

export async function GET() {
  const kv = await getKV()

  // ── 1. KV FRESH ────────────────────────────────────────────────
  if (kv) {
    const fresh = await readKvFresh(kv)
    if (fresh) {
      return NextResponse.json(fresh, {
        headers: {
          "Cache-Control":
            "public, max-age=3600, stale-while-revalidate=86400",
        },
      })
    }
  }

  // ── 2. UPSTREAM ────────────────────────────────────────────────
  const live = await tryDefiLlama()
  if (live) {
    const body: StablecoinTotalResponse = {
      totalUsd: live.totalUsd,
      asOfDate: isoDate(live.dateMs),
      asOf: isoMonth(live.dateMs),
      source: "defillama",
      fetchedAt: Date.now(),
    }
    if (kv) void writeKv(kv, body)
    return NextResponse.json(body, {
      headers: {
        "Cache-Control":
          "public, max-age=3600, stale-while-revalidate=86400",
      },
    })
  }

  // ── 3. KV STASH ────────────────────────────────────────────────
  if (kv) {
    const stash = await readKvStash(kv)
    if (stash) {
      return NextResponse.json(
        { ...stash, source: "stash" } satisfies StablecoinTotalResponse,
        {
          headers: {
            "Cache-Control":
              "public, max-age=300, stale-while-revalidate=3600",
          },
        }
      )
    }
  }

  // ── 4. UPSTREAM DOWN, NO KV ────────────────────────────────────
  // Return 503 so the client falls back to its legacy CMC-sum path
  // instead of rendering a misleading zero.
  return NextResponse.json(
    { error: "stablecoin-total upstream unavailable" },
    { status: 503 }
  )
}
