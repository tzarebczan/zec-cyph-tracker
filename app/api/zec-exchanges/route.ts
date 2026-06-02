import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"

// ZEC exchange-distribution endpoint. Powers the dashboard's "TOP MARKETS"
// at-a-glance strip and the /stats EXCHANGES sub-tab heat-map.
//
// Source of truth is CoinGecko's per-coin tickers feed:
//   GET /coins/zcash/tickers?include_exchange_logo=true&order=volume_desc&page=N
//
// CG returns up to 100 tickers per page. Most days ZEC has ~120-180 active
// pairs across all venues, so we paginate up to 3 pages and stop early on
// the first short page. Per-pair volume is converted to USD via CG's
// `converted_volume.usd`, which already accounts for the target asset
// (USDT / KRW / BTC / etc.) so we never have to FX-convert ourselves.
//
// Caching mirrors /api/markets:
//  - Fresh KV cache (10 min TTL) absorbs SWR refresh storms.
//  - Long-lived stale mirror (no TTL) keeps the page rendering through
//    a CG outage / rate-limit window.

const CG_TICKERS_BASE =
  "https://api.coingecko.com/api/v3/coins/zcash/tickers?include_exchange_logo=true&order=volume_desc"
const PAGES_TO_FETCH = 3

// Bumped (v1 -> v1) on first deploy. Bump on any payload-shape change.
const KV_KEY = "zec.exchanges.v1"
const KV_TTL_SECONDS = 10 * 60
const KV_STALE_KEY = "zec.exchanges.stale.v1"

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json",
}

// ---------- Types -----------------------------------------------------------

interface CGMarket {
  name?: string | null
  identifier?: string | null
  logo?: string | null
}

interface CGTicker {
  base?: string | null
  target?: string | null
  market?: CGMarket | null
  last?: number | null
  volume?: number | null
  converted_last?: { usd?: number | null } | null
  converted_volume?: { usd?: number | null } | null
  trust_score?: string | null
  bid_ask_spread_percentage?: number | null
  trade_url?: string | null
}

interface CGTickersResponse {
  tickers?: CGTicker[]
}

interface ZecMarketTicker {
  exchange: string
  exchangeId: string
  exchangeLogo: string | null
  base: string
  target: string
  pair: string
  lastPriceUsd: number | null
  volumeUsd24h: number | null
  volumeShare: number
  trustScore: string | null
  bidAskSpread: number | null
  tradeUrl: string | null
}

interface ZecExchangeAgg {
  exchange: string
  exchangeId: string
  exchangeLogo: string | null
  volumeUsd24h: number
  share: number
  marketCount: number
  trustScore: string | null
}

interface ZecPairAgg {
  pair: string
  volumeUsd24h: number
  share: number
  marketCount: number
}

interface ZecExchangesResponse {
  total24hVolumeUsd: number
  marketCount: number
  exchangeCount: number
  markets: ZecMarketTicker[]
  byExchange: ZecExchangeAgg[]
  byPair: ZecPairAgg[]
  source: string
  fetchedAt: number
  stale?: boolean
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

// ---------- Upstream fetch + normalise -------------------------------------

async function fetchCoinGeckoTickers(): Promise<CGTicker[] | null> {
  const all: CGTicker[] = []
  for (let page = 1; page <= PAGES_TO_FETCH; page++) {
    try {
      const url = `${CG_TICKERS_BASE}&page=${page}`
      const res = await fetch(url, { headers: HEADERS, cache: "no-store" })
      if (!res.ok) {
        // Page-1 failure is fatal; failures on later pages are tolerable
        // because the first page already has the highest-volume pairs.
        if (page === 1) return null
        break
      }
      const j = (await res.json()) as CGTickersResponse
      const tickers = j?.tickers ?? []
      if (tickers.length === 0) break
      all.push(...tickers)
      // CG returns 100 per page when more exist; a short page means we've
      // hit the end of the list and can stop paginating.
      if (tickers.length < 100) break
    } catch {
      if (page === 1) return null
      break
    }
  }
  return all.length > 0 ? all : null
}

/** Quick lowercase comparison for the trust-score worst-case rollup
 *  inside `aggregateByExchange`. CG returns "green" | "yellow" | "red",
 *  and we want the worst score across all of an exchange's pairs to be
 *  surfaced (a venue with one good pair and one shady pair should not
 *  inherit the good label). */
function trustRank(t: string | null): number {
  if (!t) return 1
  const v = t.toLowerCase()
  if (v === "green") return 3
  if (v === "yellow") return 2
  if (v === "red") return 1
  return 0
}

function normaliseTickers(raw: CGTicker[]): {
  markets: ZecMarketTicker[]
  total24hVolumeUsd: number
} {
  // Filter out tickers missing the venue identity or USD-converted volume.
  // CG occasionally returns half-populated rows for newly-listed pairs;
  // they'd just zero-volume rows in the heat-map and confuse the user.
  const useable = raw
    .filter((t) => {
      const exId = (t.market?.identifier ?? "").trim()
      const vol = t.converted_volume?.usd ?? null
      return exId.length > 0 && typeof vol === "number" && vol > 0
    })
    .map<ZecMarketTicker>((t) => {
      const base = (t.base ?? "ZEC").toUpperCase()
      const target = (t.target ?? "").toUpperCase()
      return {
        exchange: t.market?.name ?? t.market?.identifier ?? "—",
        exchangeId: (t.market?.identifier ?? "").toLowerCase(),
        exchangeLogo: t.market?.logo ?? null,
        base,
        target,
        pair: target ? `${base}/${target}` : base,
        lastPriceUsd: t.converted_last?.usd ?? null,
        volumeUsd24h: t.converted_volume?.usd ?? null,
        volumeShare: 0, // filled in below once we know the total
        trustScore:
          typeof t.trust_score === "string" ? t.trust_score.toLowerCase() : null,
        bidAskSpread:
          typeof t.bid_ask_spread_percentage === "number"
            ? t.bid_ask_spread_percentage
            : null,
        tradeUrl: t.trade_url ?? null,
      }
    })

  const total = useable.reduce((s, m) => s + (m.volumeUsd24h ?? 0), 0)
  const markets = useable
    .map((m) => ({
      ...m,
      volumeShare:
        total > 0 && m.volumeUsd24h != null ? m.volumeUsd24h / total : 0,
    }))
    .sort((a, b) => (b.volumeUsd24h ?? 0) - (a.volumeUsd24h ?? 0))

  return { markets, total24hVolumeUsd: total }
}

function aggregateByExchange(
  markets: ZecMarketTicker[],
  total: number
): ZecExchangeAgg[] {
  const map = new Map<string, ZecExchangeAgg>()
  for (const m of markets) {
    const ex = map.get(m.exchangeId)
    if (ex) {
      ex.volumeUsd24h += m.volumeUsd24h ?? 0
      ex.marketCount += 1
      // Worst trust score across pairs on this venue (so a single shady
      // pair doesn't get hidden behind the venue's best one).
      if (trustRank(m.trustScore) < trustRank(ex.trustScore)) {
        ex.trustScore = m.trustScore
      }
    } else {
      map.set(m.exchangeId, {
        exchange: m.exchange,
        exchangeId: m.exchangeId,
        exchangeLogo: m.exchangeLogo,
        volumeUsd24h: m.volumeUsd24h ?? 0,
        share: 0,
        marketCount: 1,
        trustScore: m.trustScore,
      })
    }
  }
  const out = Array.from(map.values())
    .map((ex) => ({
      ...ex,
      share: total > 0 ? ex.volumeUsd24h / total : 0,
    }))
    .sort((a, b) => b.volumeUsd24h - a.volumeUsd24h)
  return out
}

function aggregateByPair(
  markets: ZecMarketTicker[],
  total: number
): ZecPairAgg[] {
  const map = new Map<string, ZecPairAgg>()
  for (const m of markets) {
    const ex = map.get(m.pair)
    if (ex) {
      ex.volumeUsd24h += m.volumeUsd24h ?? 0
      ex.marketCount += 1
    } else {
      map.set(m.pair, {
        pair: m.pair,
        volumeUsd24h: m.volumeUsd24h ?? 0,
        share: 0,
        marketCount: 1,
      })
    }
  }
  return Array.from(map.values())
    .map((p) => ({
      ...p,
      share: total > 0 ? p.volumeUsd24h / total : 0,
    }))
    .sort((a, b) => b.volumeUsd24h - a.volumeUsd24h)
}

// ---------- Route handler ---------------------------------------------------

export async function GET() {
  const kv = await getKV()

  // 1) Fresh KV hit
  if (kv) {
    try {
      const cached = await kv.get(KV_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as ZecExchangesResponse
        if (Array.isArray(parsed.markets) && parsed.markets.length > 0) {
          return NextResponse.json(parsed, {
            headers: { "Cache-Control": "public, max-age=60" },
          })
        }
      }
    } catch {
      /* fall through */
    }
  }

  // 2) Upstream fetch
  const tickers = await fetchCoinGeckoTickers()
  if (!tickers || tickers.length === 0) {
    // 2b) Fallback: long-lived stale mirror.
    if (kv) {
      try {
        const stale = await kv.get(KV_STALE_KEY)
        if (stale) {
          const parsed = JSON.parse(stale) as ZecExchangesResponse
          if (Array.isArray(parsed.markets) && parsed.markets.length > 0) {
            return NextResponse.json(
              { ...parsed, stale: true },
              { headers: { "Cache-Control": "public, max-age=60" } }
            )
          }
        }
      } catch {
        /* fall through */
      }
    }
    return NextResponse.json(
      { error: "ZEC exchange tickers upstream failed" },
      { status: 502 }
    )
  }

  const { markets, total24hVolumeUsd } = normaliseTickers(tickers)
  const byExchange = aggregateByExchange(markets, total24hVolumeUsd)
  const byPair = aggregateByPair(markets, total24hVolumeUsd)

  const payload: ZecExchangesResponse = {
    total24hVolumeUsd,
    marketCount: markets.length,
    exchangeCount: byExchange.length,
    markets,
    byExchange,
    byPair,
    source: "coingecko",
    fetchedAt: Date.now(),
  }

  // 3) Persist (fresh + stale mirror).
  if (kv) {
    const json = JSON.stringify(payload)
    try {
      await Promise.all([
        kv.put(KV_KEY, json, { expirationTtl: KV_TTL_SECONDS }),
        kv.put(KV_STALE_KEY, json),
      ])
    } catch {
      /* best-effort */
    }
  }

  return NextResponse.json(payload, {
    headers: { "Cache-Control": "public, max-age=60" },
  })
}
