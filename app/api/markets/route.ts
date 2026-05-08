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
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=80&page=1&sparkline=false&price_change_percentage=24h"
const COINPAPRIKA_URL =
  "https://api.coinpaprika.com/v1/tickers?limit=80"

const KV_KEY = "markets.top50.v3"
const KV_TTL_SECONDS = 10 * 60 // 10 minutes
// Long-lived mirror written on every successful fetch. No TTL, so when
// both CoinGecko and CoinPaprika are down — or our IP is rate-limited
// for an hour — we can still serve the last-known-good leaderboard
// instead of bombing the page with "Couldn't load market data". The
// fresh KV_KEY entry is preferred when present; this only activates
// after the 10m fresh-cache expires AND both upstreams fail.
const KV_STALE_KEY = "markets.top50.stale.v3"

// Symbols we strip from the leaderboard before re-ranking. Each entry
// is either a wrapped/staked derivative of a coin already in the list
// (so it'd otherwise double-count BTC or ETH market cap), or a niche
// tokenized real-world-asset that floats into the top-50 unpredictably
// without being something users compare ZEC against. Matches CMC's
// default top-N view, where ZEC sits at ~#13 instead of CoinGecko's
// ~#17. To bring back any of these, just remove the symbol — the UI
// will silently include it again.
const EXCLUDED_SYMBOLS = new Set([
  // Wrapped / staked / liquid-restaking versions of BTC and ETH
  "WBTC",
  "WSTETH",
  "STETH",
  "WETH",
  "METH",
  "RETH",
  "CBETH",
  "WBETH",
  "EZETH",
  "WEETH",
  // Tokenized RWA / mortgage products that briefly float top-50
  "FIGR_HELOC",
  // Stablecoins beyond the universally-tracked USDT / USDC. USDS is
  // Sky/MakerDAO's rebrand of DAI; USDe is Ethena's synthetic dollar.
  "USDS",
  "USDE",
  // Bridged / pegged variants
  "WBT",
])
// We pull 80 from each upstream so that after filtering we still
// reliably have enough rows to render a clean top-50.
const TARGET_TOP = 50

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
  /** Symbols stripped from the upstream list before re-ranking — see
   *  EXCLUDED_SYMBOLS below for the rationale. */
  excluded: string[]
  /** Set when serving from the long-lived stale mirror because both
   *  upstreams failed. Clients can surface a small "cached" indicator. */
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

type RawCoin = Omit<MarketCoin, "rank">

async function fetchCoinGecko(): Promise<RawCoin[] | null> {
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

async function fetchCoinPaprika(): Promise<RawCoin[] | null> {
  try {
    const res = await fetch(COINPAPRIKA_URL, {
      headers: HEADERS,
      cache: "no-store",
    })
    if (!res.ok) return null
    const json = (await res.json()) as PaprikaTicker[]
    return json
      .filter((c) => typeof c.rank === "number" && c.rank > 0 && c.rank <= 80)
      .sort((a, b) => (a.rank as number) - (b.rank as number))
      .map((c) => ({
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

  // 2) Upstream chain. Both helpers return upstream order; filter and
  //    re-rank below so the response always reflects our cleaned view.
  let raw = await fetchCoinGecko()
  let source: MarketsResponse["source"] = "coingecko"
  if (!raw || raw.length === 0) {
    raw = await fetchCoinPaprika()
    source = "coinpaprika"
  }

  // 2b) Both upstreams failed. Fall back to the long-lived stale
  //     mirror so the leaderboard keeps rendering during a CoinGecko
  //     rate-limit / outage window. Mark the response as stale so a
  //     future client could surface a banner if it cares.
  if (!raw || raw.length === 0) {
    if (kv) {
      try {
        const stale = await kv.get(KV_STALE_KEY)
        if (stale) {
          const parsed = JSON.parse(stale) as MarketsResponse
          if (Array.isArray(parsed.coins) && parsed.coins.length > 0) {
            return NextResponse.json(
              { ...parsed, stale: true },
              { headers: { "Cache-Control": "public, max-age=60" } }
            )
          }
        }
      } catch {
        /* fall through to error */
      }
    }
    return NextResponse.json(
      { error: "All market-data upstreams failed" },
      { status: 502 }
    )
  }

  // Filter out wrapped / RWA / niche-stable tokens, then re-rank 1..N
  // by market cap. ZEC's rank in the response now matches what users
  // see on CMC's default top-N view (which excludes the same set),
  // and /api/zec-stats picks up the same ranks via its KV read.
  const coins: MarketCoin[] = raw
    .filter((c) => !EXCLUDED_SYMBOLS.has(c.symbol))
    .slice(0, TARGET_TOP)
    .map((c, i) => ({ rank: i + 1, ...c }))

  const payload: MarketsResponse = {
    coins,
    fetchedAt: Date.now(),
    source,
    /** Symbols filtered out before re-ranking. UI can surface this so
     *  users understand why ZEC's rank here is lower than on CoinGecko. */
    excluded: Array.from(EXCLUDED_SYMBOLS),
  }

  // 3) Persist — write both the fresh-cache and the long-lived stale
  //    mirror. Two separate writes (rather than one) so the stale key
  //    keeps surviving even when fresh has expired and we're between
  //    successful upstream fetches.
  if (kv) {
    const json = JSON.stringify(payload)
    try {
      await Promise.all([
        kv.put(KV_KEY, json, { expirationTtl: KV_TTL_SECONDS }),
        kv.put(KV_STALE_KEY, json), // no TTL — last-known-good
      ])
    } catch {
      /* best-effort */
    }
  }

  return NextResponse.json(payload, {
    headers: { "Cache-Control": "public, max-age=60" },
  })
}
