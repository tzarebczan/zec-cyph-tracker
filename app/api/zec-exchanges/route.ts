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

// v2: bumped from v1 when we extended the per-exchange aggregation
// with `volumeChange24h` (vs prior UTC day). Old v1 cache entries
// don't have the field — bumping invalidates them so we don't serve
// `null` change percentages for the entire 10-min fresh window after
// the deploy.
const KV_KEY = "zec.exchanges.v2"
const KV_TTL_SECONDS = 10 * 60
const KV_STALE_KEY = "zec.exchanges.stale.v2"
// Per-UTC-day per-exchange volume snapshot. Written on every successful
// fetch (overwriting today's bucket); the LAST write of each day acts
// as the "end-of-day" reference for the following day's % change. Key
// shape: `zec.exchanges.daily.YYYYMMDD`. Stored as a small `{ id:
// volume }` map plus the snapshot's wall-clock so we can sanity-check
// staleness when reading. No TTL — we want yesterday's snapshot to
// survive even when the fresh cache key has already rolled over.
const KV_DAILY_KEY_PREFIX = "zec.exchanges.daily."
// Keep ~10 days of history before relying on Workers KV's eventual
// list+delete sweep. We never read more than 1 day back, but holding
// a small tail makes manual debugging via the dashboard easier.

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
  volumeChange24h: number | null
}

/** Wire-shape of the per-day volume snapshot we keep in KV. Keeps a
 *  flat `{ exchangeId: usdVolume }` map plus the snapshot wall-clock
 *  so debugging tools can tell when each bucket was last written. */
interface DailySnapshot {
  /** Unix-millis when this snapshot was last written. */
  ts: number
  /** Map of exchange identifier (CG `market.identifier`) to its
   *  rolling 24h USD volume at snapshot time. */
  volumes: Record<string, number>
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
        volumeChange24h: null,
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

// ---------- Daily-snapshot helpers -----------------------------------------

/** UTC-day key for the per-exchange volume snapshot ring. We deliberately
 *  bucket by UTC date rather than by hour: CoinGecko's per-pair volumes
 *  are themselves rolling-24h windows, so an hour-aligned compare would
 *  give a 1h-vs-1h delta that tracks intraday noise more than day-over-
 *  day momentum. UTC-day keys give us a "yesterday's-end snapshot vs
 *  today's-end snapshot" comparison once we've been live for >1 day. */
function dailyKey(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0")
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0")
  const day = d.getUTCDate().toString().padStart(2, "0")
  return `${KV_DAILY_KEY_PREFIX}${y}${m}${day}`
}

/** Pull the previous UTC-day's per-exchange volume snapshot from KV.
 *  Returns null when no snapshot exists yet (first-day rollout) or when
 *  the bucket is malformed. */
async function readPrevDaySnapshot(kv: KVLike): Promise<DailySnapshot | null> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  try {
    const raw = await kv.get(dailyKey(yesterday))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DailySnapshot>
    if (
      typeof parsed?.ts === "number" &&
      parsed.volumes &&
      typeof parsed.volumes === "object"
    ) {
      return parsed as DailySnapshot
    }
  } catch {
    /* swallow */
  }
  return null
}

/** Mutate `byExchange` in place to carry `volumeChange24h` derived from
 *  `prev`. Items absent from the prior snapshot (newly-listed venues,
 *  zero-volume yesterday, or filtered-out) keep `null`, which the UI
 *  renders as a dash. */
function applyVolumeChange(
  byExchange: ZecExchangeAgg[],
  prev: DailySnapshot | null
): void {
  if (!prev) return
  for (const ex of byExchange) {
    const prevVol = prev.volumes[ex.exchangeId]
    if (typeof prevVol === "number" && prevVol > 0) {
      ex.volumeChange24h = ((ex.volumeUsd24h - prevVol) / prevVol) * 100
    }
  }
}

/** Serialise the current per-exchange volumes for the daily KV ring. */
function buildSnapshot(byExchange: ZecExchangeAgg[]): DailySnapshot {
  const volumes: Record<string, number> = {}
  for (const ex of byExchange) {
    volumes[ex.exchangeId] = ex.volumeUsd24h
  }
  return { ts: Date.now(), volumes }
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

  // Per-exchange % change vs the previous UTC-day snapshot. No-op on
  // fresh deploys (yesterday's bucket doesn't exist yet) — the field
  // stays null per-row and the UI renders "—". Once we've been live
  // through one full UTC day rollover, every venue that traded both
  // days lights up with a real delta.
  if (kv) {
    const prev = await readPrevDaySnapshot(kv)
    applyVolumeChange(byExchange, prev)
  }

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

  // 3) Persist (fresh + stale mirror) AND today's daily snapshot. The
  //    fresh + stale writes carry the user-facing payload; the daily
  //    write is the small `{id: volume}` map that drives tomorrow's
  //    `volumeChange24h`.
  //
  //    Today's daily key uses WRITE-IF-ABSENT semantics: the FIRST
  //    fetch of each UTC day pins the snapshot, and subsequent fetches
  //    leave it alone. This gives a stable, ~24h-aligned compare to
  //    yesterday's snapshot. (If we overwrote on every fetch instead,
  //    yesterday's bucket would always end up holding yesterday's
  //    last-write-before-midnight, and today-morning vs yesterday-
  //    11:55pm is only ~12h apart — too tight to read as "day-over-
  //    day".)
  if (kv) {
    const json = JSON.stringify(payload)
    const todayKey = dailyKey(new Date())
    let writeTodaySnapshot = true
    try {
      const existing = await kv.get(todayKey)
      if (existing) writeTodaySnapshot = false
    } catch {
      /* if the read fails, fall through and try the write anyway */
    }
    const writes: Promise<unknown>[] = [
      kv.put(KV_KEY, json, { expirationTtl: KV_TTL_SECONDS }),
      kv.put(KV_STALE_KEY, json),
    ]
    if (writeTodaySnapshot) {
      const snapshot = JSON.stringify(buildSnapshot(byExchange))
      writes.push(kv.put(todayKey, snapshot))
    }
    try {
      await Promise.all(writes)
    } catch {
      /* best-effort */
    }
  }

  return NextResponse.json(payload, {
    headers: { "Cache-Control": "public, max-age=60" },
  })
}
