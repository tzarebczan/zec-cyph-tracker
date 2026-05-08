import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

// Aggregated Zcash-specific supply stats for the /stats Supply tab.
// Pulls everything CoinGecko + CoinPaprika expose (circulating, total,
// max supply, ATH, etc.) and bolts on a best-effort shielded-supply
// fetch from a list of community endpoints. Each layer fails open —
// if shielded data isn't available, the response just omits that field
// and the UI falls back to "data unavailable" + a manual link.
//
// All upstream calls are cached in Workers KV; shielded gets the
// longest TTL (24h) since it changes slowly and is the hardest to
// re-fetch reliably.

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/coins/zcash?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false"
const COINPAPRIKA_URL = "https://api.coinpaprika.com/v1/coins/zec-zcash"

// Best-effort shielded-supply candidates. Each is checked in order with
// a tight timeout; first one that returns a positive number wins. Easy
// to add new sources here without touching the rest of the route.
const SHIELDED_CANDIDATES = [
  // Blockchair has Zcash stats but doesn't expose shielded directly —
  // omitted here. If a community endpoint surfaces, drop it in:
  //   "https://api.example.com/zcash/shielded",
] as const

const KV_STATS_KEY = "zec.stats.v1"
const KV_STATS_TTL = 60 * 60 // 1h
const KV_SHIELDED_KEY = "zec.shielded.v1"
const KV_SHIELDED_TTL = 24 * 60 * 60 // 24h — slow-moving, hard to re-fetch

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json",
}

interface ZecStats {
  rank: number | null
  marketCap: number | null
  price: number | null
  change24h: number | null
  circulating: number | null
  total: number | null
  max: number
  ath: number | null
  athChangePct: number | null
  shielded: number | null
  shieldedSource: string | null
  source: "coingecko" | "coinpaprika" | null
  fetchedAt: number
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

interface CGZcash {
  market_cap_rank?: number | null
  market_data?: {
    current_price?: { usd?: number | null } | null
    market_cap?: { usd?: number | null } | null
    price_change_percentage_24h?: number | null
    circulating_supply?: number | null
    total_supply?: number | null
    max_supply?: number | null
    ath?: { usd?: number | null } | null
    ath_change_percentage?: { usd?: number | null } | null
  } | null
}

async function fetchCoinGecko(): Promise<Partial<ZecStats> | null> {
  try {
    const res = await fetch(COINGECKO_URL, {
      headers: HEADERS,
      cache: "no-store",
    })
    if (!res.ok) return null
    const j = (await res.json()) as CGZcash
    const md = j.market_data
    return {
      rank: j.market_cap_rank ?? null,
      price: md?.current_price?.usd ?? null,
      marketCap: md?.market_cap?.usd ?? null,
      change24h: md?.price_change_percentage_24h ?? null,
      circulating: md?.circulating_supply ?? null,
      total: md?.total_supply ?? null,
      max: md?.max_supply ?? 21_000_000,
      ath: md?.ath?.usd ?? null,
      athChangePct: md?.ath_change_percentage?.usd ?? null,
      source: "coingecko",
    }
  } catch {
    return null
  }
}

interface PaprikaCoin {
  rank?: number | null
  total_supply?: number | null
  max_supply?: number | null
  circulating_supply?: number | null
  quotes?: {
    USD?: {
      price?: number
      market_cap?: number
      percent_change_24h?: number
      ath_price?: number
      percent_from_price_ath?: number
    }
  }
}

async function fetchCoinPaprika(): Promise<Partial<ZecStats> | null> {
  try {
    const res = await fetch(COINPAPRIKA_URL, {
      headers: HEADERS,
      cache: "no-store",
    })
    if (!res.ok) return null
    const j = (await res.json()) as PaprikaCoin
    return {
      rank: j.rank ?? null,
      price: j.quotes?.USD?.price ?? null,
      marketCap: j.quotes?.USD?.market_cap ?? null,
      change24h: j.quotes?.USD?.percent_change_24h ?? null,
      circulating: j.circulating_supply ?? null,
      total: j.total_supply ?? null,
      max: j.max_supply ?? 21_000_000,
      ath: j.quotes?.USD?.ath_price ?? null,
      athChangePct: j.quotes?.USD?.percent_from_price_ath ?? null,
      source: "coinpaprika",
    }
  } catch {
    return null
  }
}

async function fetchShielded(
  kv: KVLike | null
): Promise<{ value: number | null; source: string | null }> {
  if (kv) {
    try {
      const cached = await kv.get(KV_SHIELDED_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as {
          value: number
          source: string
        }
        if (
          typeof parsed?.value === "number" &&
          parsed.value > 0 &&
          typeof parsed?.source === "string"
        ) {
          return { value: parsed.value, source: parsed.source }
        }
      }
    } catch {
      /* fall through */
    }
  }
  for (const url of SHIELDED_CANDIDATES) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) continue
      const txt = await res.text()
      // Try JSON shapes the candidates might return; fall back to a
      // numeric-extract from text. Keep this loose so a new endpoint
      // doesn't need a per-source parser.
      let v: number | null = null
      try {
        const j = JSON.parse(txt) as Record<string, unknown>
        const candidates = [
          j.shielded,
          j.shielded_supply,
          j.shieldedSupply,
          (j.data as Record<string, unknown> | undefined)?.shielded,
        ]
        for (const c of candidates) {
          if (typeof c === "number" && c > 0) {
            v = c
            break
          }
        }
      } catch {
        const m = txt.match(/shielded[^0-9]{0,32}(\d[\d,.]*)/i)
        if (m) {
          const n = parseFloat(m[1].replace(/,/g, ""))
          if (Number.isFinite(n) && n > 0) v = n
        }
      }
      if (v != null) {
        if (kv) {
          try {
            await kv.put(
              KV_SHIELDED_KEY,
              JSON.stringify({ value: v, source: url }),
              { expirationTtl: KV_SHIELDED_TTL }
            )
          } catch {}
        }
        return { value: v, source: url }
      }
    } catch {
      /* try next */
    }
  }
  return { value: null, source: null }
}

export async function GET() {
  const kv = await getKV()

  // 1) KV cache hit on the combined stats payload
  if (kv) {
    try {
      const cached = await kv.get(KV_STATS_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as ZecStats
        if (parsed?.circulating != null) {
          return NextResponse.json(parsed, {
            headers: { "Cache-Control": "public, max-age=60" },
          })
        }
      }
    } catch {
      /* fall through */
    }
  }

  // 2) Fetch market data from CoinGecko, fallback CoinPaprika
  let market = await fetchCoinGecko()
  if (!market || market.circulating == null) {
    market = await fetchCoinPaprika()
  }
  if (!market) {
    return NextResponse.json(
      { error: "ZEC stats upstreams failed" },
      { status: 502 }
    )
  }

  // 3) Best-effort shielded fetch
  const shielded = await fetchShielded(kv)

  const payload: ZecStats = {
    rank: market.rank ?? null,
    marketCap: market.marketCap ?? null,
    price: market.price ?? null,
    change24h: market.change24h ?? null,
    circulating: market.circulating ?? null,
    total: market.total ?? null,
    max: market.max ?? 21_000_000,
    ath: market.ath ?? null,
    athChangePct: market.athChangePct ?? null,
    shielded: shielded.value,
    shieldedSource: shielded.source,
    source: market.source ?? null,
    fetchedAt: Date.now(),
  }

  if (kv) {
    try {
      await kv.put(KV_STATS_KEY, JSON.stringify(payload), {
        expirationTtl: KV_STATS_TTL,
      })
    } catch {}
  }

  return NextResponse.json(payload, {
    headers: { "Cache-Control": "public, max-age=60" },
  })
}
