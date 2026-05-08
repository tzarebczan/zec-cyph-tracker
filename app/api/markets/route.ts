import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

// Top-N crypto market caps for the rankings page + the dashboard ZEC
// rank chip. CoinGecko free tier (30 req/min) is the primary source;
// CoinPaprika is a fallback (separate IP rate-limit pool, free, no auth).
//
// We cache in Workers KV for ~10 min — fresh enough that a top-20 rank
// shuffle shows up promptly, but more than aggressive enough that a
// burst of dashboard refreshes doesn't pound CoinGecko. Each CF region
// shares the same KV value so cross-region traffic costs the same as
// single-region.

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false&price_change_percentage=24h"
const COINPAPRIKA_URL =
  "https://api.coinpaprika.com/v1/tickers?limit=50"

const KV_KEY = "markets.top50.v2"
const KV_TTL_SECONDS = 10 * 60 // 10 minutes

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json",
}

interface MarketCoin {
  rank: number
  symbol: string
  name: string
  id: string
  marketCap: number | null
  price: number | null
  change24h: number | null
  circulatingSupply: number | null
  totalSupply: number | null
  maxSupply: number | null
  image: string | null
}

interface MarketsResponse {
  coins: MarketCoin[]
  fetchedAt: number
  source: "coingecko" | "coinpaprika"
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

interface CoinGeckoMarket {
  id?: string
  symbol?: string
  name?: string
  market_cap_rank?: number | null
  market_cap?: number | null
  current_price?: number | null
  price_change_percentage_24h?: number | null
  circulating_supply?: number | null
  total_supply?: number | null
  max_supply?: number | null
  image?: string | null
}

async function fetchCoinGecko(): Promise<MarketCoin[] | null> {
  try {
    const res = await fetch(COINGECKO_URL, {
      headers: HEADERS,
      cache: "no-store",
    })
    if (!res.ok) return null
    const json = (await res.json()) as CoinGeckoMarket[]
    return json
      .filter((c) => c.market_cap_rank != null && c.market_cap != null)
      .map((c) => ({
        rank: c.market_cap_rank as number,
        symbol: (c.symbol ?? "").toUpperCase(),
        name: c.name ?? "",
        id: c.id ?? "",
        marketCap: c.market_cap ?? null,
        price: c.current_price ?? null,
        change24h: c.price_change_percentage_24h ?? null,
        circulatingSupply: c.circulating_supply ?? null,
        totalSupply: c.total_supply ?? null,
        maxSupply: c.max_supply ?? null,
        image: c.image ?? null,
      }))
  } catch {
    return null
  }
}

interface PaprikaTicker {
  id?: string
  name?: string
  symbol?: string
  rank?: number
  total_supply?: number
  max_supply?: number
  circulating_supply?: number
  quotes?: {
    USD?: {
      price?: number
      market_cap?: number
      percent_change_24h?: number
    }
  }
}

async function fetchCoinPaprika(): Promise<MarketCoin[] | null> {
  try {
    const res = await fetch(COINPAPRIKA_URL, {
      headers: HEADERS,
      cache: "no-store",
    })
    if (!res.ok) return null
    const json = (await res.json()) as PaprikaTicker[]
    return json
      .filter((c) => typeof c.rank === "number" && c.rank > 0 && c.rank <= 50)
      .map((c) => ({
        rank: c.rank as number,
        symbol: (c.symbol ?? "").toUpperCase(),
        name: c.name ?? "",
        id: c.id ?? "",
        marketCap: c.quotes?.USD?.market_cap ?? null,
        price: c.quotes?.USD?.price ?? null,
        change24h: c.quotes?.USD?.percent_change_24h ?? null,
        circulatingSupply: c.circulating_supply ?? null,
        totalSupply: c.total_supply ?? null,
        maxSupply: c.max_supply ?? null,
        // CoinPaprika hosts per-coin logos at a predictable path. Saves
        // the table from rendering as a wall of plain tickers when we
        // fall back to this source.
        image: c.id ? `https://static.coinpaprika.com/coin/${c.id}/logo.png` : null,
      }))
      .sort((a, b) => a.rank - b.rank)
  } catch {
    return null
  }
}

export async function GET() {
  const kv = await getKV()
  // 1) KV hit
  if (kv) {
    try {
      const cached = await kv.get(KV_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as MarketsResponse
        if (Array.isArray(parsed.coins) && parsed.coins.length > 0) {
          return NextResponse.json(parsed, {
            headers: { "Cache-Control": "public, max-age=60" },
          })
        }
      }
    } catch {
      /* fall through */
    }
  }

  // 2) Upstream chain
  let coins = await fetchCoinGecko()
  let source: MarketsResponse["source"] = "coingecko"
  if (!coins || coins.length === 0) {
    coins = await fetchCoinPaprika()
    source = "coinpaprika"
  }
  if (!coins || coins.length === 0) {
    return NextResponse.json(
      { error: "All market-data upstreams failed" },
      { status: 502 }
    )
  }

  const payload: MarketsResponse = {
    coins,
    fetchedAt: Date.now(),
    source,
  }

  // 3) Persist
  if (kv) {
    try {
      await kv.put(KV_KEY, JSON.stringify(payload), {
        expirationTtl: KV_TTL_SECONDS,
      })
    } catch {
      /* best-effort */
    }
  }

  return NextResponse.json(payload, {
    headers: { "Cache-Control": "public, max-age=60" },
  })
}
