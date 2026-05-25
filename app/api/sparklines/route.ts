import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

// 90-day mcap sparklines for the live-historical sections of /what-if.
//
// Sources:
//   • BTC + DOGE → CoinGecko /coins/{id}/market_chart?days=90
//   • Stablecoins → DefiLlama /stablecoincharts/all (already used by
//     /api/stablecoins-total for the latest point; here we pull the
//     full 90d slice)
//
// Sections that don't have a clean historical series — offshore wealth,
// global GDP, gold — return null and the UI just skips them. KV cached
// for 6h fresh + 24h stale-while-revalidate since these series only
// shift meaningfully on weekly+ timescales and the daily warmer keeps
// the edge primed.

const KV_FRESH_KEY = "sparklines.v1"
const KV_FRESH_TTL_SEC = 6 * 60 * 60 // 6h
const KV_STASH_KEY = "sparklines.lastKnown.v1"

const CG_BTC =
  "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=90&interval=daily"
const CG_DOGE =
  "https://api.coingecko.com/api/v3/coins/dogecoin/market_chart?vs_currency=usd&days=90&interval=daily"
const DEFILLAMA_URL = "https://stablecoins.llama.fi/stablecoincharts/all"

interface SparklinesResponse {
  /** BTC market cap, oldest→newest, ~90 points. Null when CoinGecko
   *  was unreachable AND the KV stash had no value to fall back to. */
  btc: number[] | null
  doge: number[] | null
  stablecoins: number[] | null
  /** YYYY-MM-DD of the most recent point across all series. */
  asOf: string
  fetchedAt: number
  source: "live" | "stash"
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

interface CoinGeckoChart {
  prices?: [number, number][]
  market_caps?: [number, number][]
  total_volumes?: [number, number][]
}

interface DefiLlamaPoint {
  date: string | number
  totalCirculating?: { peggedUSD?: number }
  totalCirculatingUSD?: { peggedUSD?: number }
}

async function fetchCoinGeckoMcaps(url: string): Promise<number[] | null> {
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as CoinGeckoChart
    const series = data?.market_caps
    if (!Array.isArray(series) || series.length === 0) return null
    // Drop the timestamp dimension; PhosphorSpark only cares about the
    // y-values. Filter out any non-finite values so a single bad point
    // can't NaN-poison the whole series.
    const mcaps = series
      .map(([, m]) => m)
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    return mcaps.length >= 2 ? mcaps : null
  } catch {
    return null
  }
}

async function fetchStablecoinsMcaps(): Promise<number[] | null> {
  try {
    const resp = await fetch(DEFILLAMA_URL, {
      headers: { Accept: "application/json" },
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as DefiLlamaPoint[]
    if (!Array.isArray(data) || data.length === 0) return null
    // Take the last 90 daily points so the stablecoin sparkline matches
    // the BTC/DOGE 90d window. DefiLlama publishes daily so this is a
    // straight slice off the tail.
    const tail = data.slice(-90)
    const mcaps = tail
      .map(
        (p) =>
          p.totalCirculating?.peggedUSD ??
          p.totalCirculatingUSD?.peggedUSD ??
          null
      )
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    return mcaps.length >= 2 ? mcaps : null
  } catch {
    return null
  }
}

function isoDate(unixMs: number): string {
  return new Date(unixMs).toISOString().slice(0, 10)
}

async function readKvFresh(kv: KVLike): Promise<SparklinesResponse | null> {
  try {
    const raw = await kv.get(KV_FRESH_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SparklinesResponse
    if (Date.now() - parsed.fetchedAt < KV_FRESH_TTL_SEC * 1000) return parsed
    return null
  } catch {
    return null
  }
}

async function readKvStash(kv: KVLike): Promise<SparklinesResponse | null> {
  try {
    const raw = await kv.get(KV_STASH_KEY)
    if (!raw) return null
    return JSON.parse(raw) as SparklinesResponse
  } catch {
    return null
  }
}

async function writeKv(kv: KVLike, body: SparklinesResponse): Promise<void> {
  await kv
    .put(KV_FRESH_KEY, JSON.stringify(body), {
      expirationTtl: KV_FRESH_TTL_SEC,
    })
    .catch(() => {})
  await kv.put(KV_STASH_KEY, JSON.stringify(body)).catch(() => {})
}

export async function GET() {
  const kv = await getKV()

  // 1. Fresh KV — under 6h old, serve as-is.
  if (kv) {
    const fresh = await readKvFresh(kv)
    if (fresh) {
      return NextResponse.json(fresh, {
        headers: {
          "Cache-Control":
            "public, max-age=21600, stale-while-revalidate=86400",
        },
      })
    }
  }

  // 2. Live fetches — run in parallel, fail soft per-source.
  const [btc, doge, stables] = await Promise.all([
    fetchCoinGeckoMcaps(CG_BTC),
    fetchCoinGeckoMcaps(CG_DOGE),
    fetchStablecoinsMcaps(),
  ])

  // If at least one series came back, treat this as a successful
  // live fetch + cache it. If everything failed, fall through to
  // the long-lived stash.
  if (btc != null || doge != null || stables != null) {
    const body: SparklinesResponse = {
      btc,
      doge,
      stablecoins: stables,
      asOf: isoDate(Date.now()),
      fetchedAt: Date.now(),
      source: "live",
    }
    if (kv) void writeKv(kv, body)
    return NextResponse.json(body, {
      headers: {
        "Cache-Control":
          "public, max-age=21600, stale-while-revalidate=86400",
      },
    })
  }

  // 3. Stash — last-known-good.
  if (kv) {
    const stash = await readKvStash(kv)
    if (stash) {
      return NextResponse.json(
        { ...stash, source: "stash" } satisfies SparklinesResponse,
        {
          headers: {
            "Cache-Control":
              "public, max-age=300, stale-while-revalidate=3600",
          },
        }
      )
    }
  }

  // 4. Total failure — return empty so the UI just skips sparklines.
  const body: SparklinesResponse = {
    btc: null,
    doge: null,
    stablecoins: null,
    asOf: isoDate(Date.now()),
    fetchedAt: Date.now(),
    source: "stash",
  }
  return NextResponse.json(body, {
    headers: { "Cache-Control": "public, max-age=60" },
  })
}
