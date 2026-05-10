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

// Cipherscan is currently the only fully-open Zcash node API surface that
// exposes shielded-pool supply with a stable JSON shape — Coin Metrics
// community gates SplyShld behind a paid plan, Blockchair charts are
// anti-bot, and Blockworks is auth-walled. The endpoint returns chain
// supply + transparent + each shielded pool (sprout/sapling/orchard/
// lockbox) + pre-computed shielded percentage, fetched live from a
// Zebra full node. Reference: https://cipherscan.app/network
const CIPHERSCAN_URL = "https://api.mainnet.cipherscan.app/api/network/stats"

const KV_STATS_KEY = "zec.stats.v6"
const KV_STATS_TTL = 60 * 60 // 1h
// Long-lived mirror of the last successful payload. No TTL — used as a
// fallback when both CoinGecko and CoinPaprika are down so the Supply
// tab keeps rendering instead of bombing with "ZEC stats upstreams
// failed". Reset only by overwriting on the next successful fetch.
const KV_STATS_STALE_KEY = "zec.stats.stale.v1"
const KV_SHIELDED_KEY = "zec.shielded.v2"
const KV_SHIELDED_TTL = 60 * 60 // 1h — cipherscan is fast + reliable now,
// no need for the 24h pessimism we needed when the source was unstable.
const KV_MCAP_HIST_KEY = "zec.mcap.hist.v3"
const KV_MCAP_HIST_TTL = 60 * 60 // 1h — daily resolution, light churn
// Same key the /api/markets route writes to. Reading from here lets us
// align /api/zec-stats's `rank` field with the leaderboard the user sees
// on /stats — CoinMarketCap and CoinGecko's /coins/zcash sometimes
// disagree on rank because of different non-circulating-supply
// heuristics, and the leaderboard's ordering is the source of truth for
// users. Must stay in lockstep with KV_KEY in /api/markets/route.ts —
// bump together when the leaderboard payload shape or source changes.
const KV_MARKETS_KEY = "markets.top50.v4"

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json",
}

interface ShieldedBreakdown {
  /** Total shielded across all pools (sapling + orchard + sprout + lockbox). */
  total: number
  /** Per-pool ZEC counts (lockbox is NU6+ — present after activation). */
  sprout: number
  sapling: number
  orchard: number
  lockbox: number
  /** Public unshielded supply on the t-address side. */
  transparent: number
  /** Pre-computed % of chain supply that's shielded. */
  pct: number
  /** Source URL for attribution / debugging. */
  source: string
}

interface ZecStats {
  rank: number | null
  marketCap: number | null
  price: number | null
  change24h: number | null
  /** True 24h mcap delta computed off CoinGecko's daily market_chart
   *  series (last vs penultimate daily close). Distinct from
   *  `change24h` which is the price-only 24h tick — for ZEC the two
   *  differ by ~0.05% from emission, but the field exists so downstream
   *  UI can label "Mcap 24h" honestly. */
  mcapChange24h: number | null
  /** Mcap % change over 7D (computed client-side from CoinGecko's daily
   *  market_chart history; ~0 emission drift over 7d so this is close to
   *  but distinct from price_change_percentage_7d). */
  mcapChange7d: number | null
  mcapChange30d: number | null
  /** [unix-ms, mcap-usd][] daily series — exposed so the Supply tab
   *  can render a 30d market-cap chart without an extra round-trip. */
  mcapSeries: [number, number][]
  circulating: number | null
  total: number | null
  max: number
  ath: number | null
  athChangePct: number | null
  shielded: number | null
  shieldedPct: number | null
  shieldedBreakdown: ShieldedBreakdown | null
  shieldedSource: string | null
  source: "coingecko" | "coinpaprika" | null
  fetchedAt: number
  /** Set when serving from the long-lived stale mirror because both
   *  upstreams failed. */
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

interface CipherscanStats {
  success?: boolean
  supply?: {
    chainSupply?: number
    transparent?: number
    sprout?: number
    sapling?: number
    orchard?: number
    lockbox?: number
    totalShielded?: number
    shieldedPercentage?: number
  }
}

async function fetchShielded(
  kv: KVLike | null
): Promise<ShieldedBreakdown | null> {
  if (kv) {
    try {
      const cached = await kv.get(KV_SHIELDED_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as ShieldedBreakdown
        if (typeof parsed?.total === "number" && parsed.total > 0) {
          return parsed
        }
      }
    } catch {
      /* fall through */
    }
  }

  try {
    const res = await fetch(CIPHERSCAN_URL, {
      // Cipherscan's API expects browser-y headers — Origin/Referer pin it
      // to the cipherscan.app frontend, which is the only allowlisted CORS
      // origin. Server-to-server calls are fine since CORS is enforced by
      // the browser, not the server, but matching the headers keeps us in
      // good standing if they ever tighten the rules.
      headers: {
        ...HEADERS,
        Origin: "https://cipherscan.app",
        Referer: "https://cipherscan.app/network",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const j = (await res.json()) as CipherscanStats
    const s = j.supply
    if (
      !s ||
      typeof s.totalShielded !== "number" ||
      s.totalShielded <= 0
    ) {
      return null
    }
    const breakdown: ShieldedBreakdown = {
      total: s.totalShielded,
      sprout: s.sprout ?? 0,
      sapling: s.sapling ?? 0,
      orchard: s.orchard ?? 0,
      lockbox: s.lockbox ?? 0,
      transparent: s.transparent ?? 0,
      pct: typeof s.shieldedPercentage === "number" ? s.shieldedPercentage : 0,
      source: CIPHERSCAN_URL,
    }
    if (kv) {
      try {
        await kv.put(KV_SHIELDED_KEY, JSON.stringify(breakdown), {
          expirationTtl: KV_SHIELDED_TTL,
        })
      } catch {}
    }
    return breakdown
  } catch {
    return null
  }
}

interface CGMarketChart {
  market_caps?: [number, number][]
}

interface McapPerf {
  mcap24h: number | null
  mcap7d: number | null
  mcap30d: number | null
  /** [unix-ms, mcap-usd][] — full daily series, exposed on the route
   *  response for the Supply tab's market-cap chart. */
  series: [number, number][]
}

/** Pull 30 daily market-cap points and compute % change for 24h / 7d /
 *  30d off the same series. Single CoinGecko call powers all three
 *  windows. Returns nulls when the upstream is unavailable so the UI
 *  can degrade. */
async function fetchMcapPerf(kv: KVLike | null): Promise<McapPerf> {
  if (kv) {
    try {
      const cached = await kv.get(KV_MCAP_HIST_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as Partial<McapPerf>
        return {
          mcap24h: parsed.mcap24h ?? null,
          mcap7d: parsed.mcap7d ?? null,
          mcap30d: parsed.mcap30d ?? null,
          series: Array.isArray(parsed.series) ? parsed.series : [],
        }
      }
    } catch {
      /* fall through */
    }
  }

  const empty: McapPerf = {
    mcap24h: null,
    mcap7d: null,
    mcap30d: null,
    series: [],
  }
  try {
    const url =
      "https://api.coingecko.com/api/v3/coins/zcash/market_chart?vs_currency=usd&days=30&interval=daily"
    const res = await fetch(url, { headers: HEADERS, cache: "no-store" })
    if (!res.ok) return empty
    const j = (await res.json()) as CGMarketChart
    const series = j.market_caps ?? []
    if (series.length < 8) return empty
    const last = series[series.length - 1][1]
    const dayAgo = series[Math.max(0, series.length - 2)][1]
    const wkAgo = series[Math.max(0, series.length - 8)][1]
    const monAgo = series[0][1]
    const pct = (then: number) =>
      then > 0 && Number.isFinite(last) && Number.isFinite(then)
        ? ((last - then) / then) * 100
        : null
    const out: McapPerf = {
      mcap24h: pct(dayAgo),
      mcap7d: pct(wkAgo),
      mcap30d: pct(monAgo),
      series,
    }
    if (kv) {
      try {
        await kv.put(KV_MCAP_HIST_KEY, JSON.stringify(out), {
          expirationTtl: KV_MCAP_HIST_TTL,
        })
      } catch {}
    }
    return out
  } catch {
    return empty
  }
}

/** Pulls today's rank from the leaderboard KV cache (written by
 *  /api/markets) so /api/zec-stats and the leaderboard agree. Falls
 *  back to whatever rank CoinGecko's /coins/zcash returned when the
 *  cache is cold. */
async function rankFromMarkets(kv: KVLike | null): Promise<number | null> {
  if (!kv) return null
  try {
    const cached = await kv.get(KV_MARKETS_KEY)
    if (!cached) return null
    const parsed = JSON.parse(cached) as {
      coins?: { rank?: number; symbol?: string }[]
    }
    const zec = parsed.coins?.find((c) => c.symbol === "ZEC")
    return typeof zec?.rank === "number" ? zec.rank : null
  } catch {
    return null
  }
}


export async function GET() {
  const kv = await getKV()

  // Read the leaderboard rank up-front so we can always overlay it on
  // the response, even when serving from cache. /api/zec-stats and the
  // Rankings table share this single source of truth — a cached payload
  // with a stale rank would otherwise drift apart from the leaderboard
  // until the 1h TTL expires.
  const liveLeaderboardRank = await rankFromMarkets(kv)

  // 1) KV cache hit on the combined stats payload
  if (kv) {
    try {
      const cached = await kv.get(KV_STATS_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as ZecStats
        if (parsed?.circulating != null) {
          return NextResponse.json(
            {
              ...parsed,
              rank: liveLeaderboardRank ?? parsed.rank ?? null,
            },
            { headers: { "Cache-Control": "public, max-age=60" } }
          )
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

  // 2b) Both upstreams failed. Fall back to the long-lived stale
  //     mirror so the Supply tab keeps rendering during a CoinGecko
  //     rate-limit or outage. Overlay the live leaderboard rank if
  //     available — it's the cheapest field to keep current.
  if (!market) {
    if (kv) {
      try {
        const stale = await kv.get(KV_STATS_STALE_KEY)
        if (stale) {
          const parsed = JSON.parse(stale) as ZecStats
          if (parsed?.circulating != null) {
            return NextResponse.json(
              {
                ...parsed,
                rank: liveLeaderboardRank ?? parsed.rank ?? null,
                stale: true,
              },
              { headers: { "Cache-Control": "public, max-age=60" } }
            )
          }
        }
      } catch {
        /* fall through to error */
      }
    }
    return NextResponse.json(
      { error: "ZEC stats upstreams failed" },
      { status: 502 }
    )
  }

  // 3) Shielded breakdown + 7D/30D mcap perf in parallel — both are
  //    independent of one another. (Leaderboard rank was fetched
  //    up-front so we can overlay it on cache hits.)
  const [shielded, mcapPerf] = await Promise.all([
    fetchShielded(kv),
    fetchMcapPerf(kv),
  ])

  const payload: ZecStats = {
    // Prefer the leaderboard rank — it's what users see on /stats and
    // what CoinGecko's /coins/markets returns. /coins/zcash sometimes
    // disagrees by ±1 because it deduplicates wrapped tokens, so we
    // only fall back to it when the leaderboard cache is cold.
    rank: liveLeaderboardRank ?? market.rank ?? null,
    marketCap: market.marketCap ?? null,
    price: market.price ?? null,
    change24h: market.change24h ?? null,
    mcapChange24h: mcapPerf.mcap24h,
    mcapChange7d: mcapPerf.mcap7d,
    mcapChange30d: mcapPerf.mcap30d,
    mcapSeries: mcapPerf.series,
    circulating: market.circulating ?? null,
    total: market.total ?? null,
    max: market.max ?? 21_000_000,
    ath: market.ath ?? null,
    athChangePct: market.athChangePct ?? null,
    shielded: shielded?.total ?? null,
    shieldedPct: shielded?.pct ?? null,
    shieldedBreakdown: shielded,
    shieldedSource: shielded?.source ?? null,
    source: market.source ?? null,
    fetchedAt: Date.now(),
  }

  if (kv) {
    const json = JSON.stringify(payload)
    try {
      // Two writes: short-TTL fresh cache + long-lived stale mirror.
      // The mirror keeps surviving past the 1h fresh expiry so a
      // Coingecko outage that lasts longer than the cache window
      // still serves the last-known-good payload.
      await Promise.all([
        kv.put(KV_STATS_KEY, json, { expirationTtl: KV_STATS_TTL }),
        kv.put(KV_STATS_STALE_KEY, json),
      ])
    } catch {}
  }

  return NextResponse.json(payload, {
    headers: { "Cache-Control": "public, max-age=60" },
  })
}
