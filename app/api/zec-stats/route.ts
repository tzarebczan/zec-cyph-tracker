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
// ironwood/lockbox) + pre-computed shielded percentage, fetched live from a
// Zebra full node. Reference: https://cipherscan.app/network
const CIPHERSCAN_URL = "https://api.mainnet.cipherscan.app/api/network/stats"

// v8: bumped from v7 to invalidate any v7 entries that were cached
// with empty mcapSeries / volumeSeries because CoinGecko was rate-
// limiting our Cloudflare egress IPs. We now have a CMC fallback +
// long-lived stale mirror for the mcap/volume series, so old empties
// should not be served.
// v10: bumped from v9 when `circulating` flipped to prefer cipherscan's
// on-chain chainSupply over the CoinGecko/CoinPaprika feed. Invalidates v9
// payloads that cached the lagging market circulating as the primary value.
// v11 adds the Ironwood pool to shieldedBreakdown.
const KV_STATS_KEY = "zec.stats.v11"
const KV_STATS_TTL = 60 * 60 // 1h
// Long-lived mirror of the last successful payload. No TTL — used as a
// fallback when both CoinGecko and CoinPaprika are down so the Supply
// tab keeps rendering instead of bombing with "ZEC stats upstreams
// failed". Reset only by overwriting on the next successful fetch.
const KV_STATS_STALE_KEY = "zec.stats.stale.v4"
const KV_SHIELDED_KEY = "zec.shielded.v4"
const KV_SHIELDED_TTL = 60 * 60 // 1h — cipherscan is fast + reliable now,
// no need for the 24h pessimism we needed when the source was unstable.
// Long-lived stale mirror, no TTL. Cipherscan times out (8s) or 5xx's
// occasionally; without this, the dashboard's shielded-% chip blinks
// off until either the upstream recovers or the 1h fresh cache rolls
// over with a successful fetch. Writing on every success and reading
// on every miss makes the chip survive any transient outage.
const KV_SHIELDED_STALE_KEY = "zec.shielded.stale.v3"
// v4: bumped from v3 when we extended McapPerf to also carry the
// 30d volume series — old v3 entries don't have it.
const KV_MCAP_HIST_KEY = "zec.mcap.hist.v4"
const KV_MCAP_HIST_TTL = 60 * 60 // 1h — daily resolution, light churn
// Long-lived stale mirror for the mcap/volume series. CoinGecko's
// public API rate-limits Cloudflare egress IPs hard, so the fresh-
// cache hour will sometimes roll over with an empty CG payload AND a
// CMC backup blip — without this mirror users see the Volume tab
// blank out. Written on every successful fetch, read whenever both
// upstreams come back empty.
const KV_MCAP_HIST_STALE_KEY = "zec.mcap.hist.stale.v1"
// Same key the /api/markets route writes to. Reading from here lets us
// align /api/zec-stats's `rank` field with the leaderboard the user sees
// on /stats — CoinMarketCap and CoinGecko's /coins/zcash sometimes
// disagree on rank because of different non-circulating-supply
// heuristics, and the leaderboard's ordering is the source of truth for
// users. Must stay in lockstep with KV_KEY in /api/markets/route.ts —
// bump together when the leaderboard payload shape or source changes.
const KV_MARKETS_KEY = "markets.top50.v10"

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json",
}

interface ShieldedBreakdown {
  /** Total on-chain ZEC supply (= circulating / mined), straight from a
   *  Zebra full node. Authoritative fallback for `circulating` when the
   *  CoinGecko/CoinPaprika market feed returns a null circulating_supply.
   *  Optional/undefined when cipherscan omits it — never stored as 0, so a
   *  missing field can't masquerade as "0 ZEC mined". */
  chainSupply?: number
  /** Total shielded across all pools, including Ironwood. */
  total: number
  /** Per-pool ZEC counts (Ironwood is NU6.3; lockbox is NU6+). */
  sprout: number
  sapling: number
  orchard: number
  ironwood: number
  lockbox: number
  /** Public unshielded supply on the t-address side. */
  transparent: number
  /** Pre-computed % of chain supply that's shielded. */
  pct: number
  /** Source URL for attribution / debugging. */
  source: string
  /** True only when this breakdown came from the no-TTL stale mirror
   *  (cipherscan down past its 1h fresh cache). In that case chainSupply
   *  may be frozen days old, so the market feed's circulating should win. */
  stale?: boolean
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
  /** Most recent 24h trading volume in USD (CoinGecko aggregate across
   *  exchanges). Powers the Volume tab's headline. */
  volume24h: number | null
  /** [unix-ms, volume-usd][] 30d daily series — same source call as
   *  mcapSeries, no extra upstream round-trip. */
  volumeSeries: [number, number][]
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
    ironwood?: number
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

  let breakdown: ShieldedBreakdown | null = null
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
    if (res.ok) {
      const j = (await res.json()) as CipherscanStats
      const s = j.supply
      if (
        s &&
        typeof s.totalShielded === "number" &&
        s.totalShielded > 0
      ) {
        breakdown = {
          // Only keep a positive finite chainSupply; a missing/renamed field
          // must stay undefined so it isn't later read as "0% mined".
          chainSupply:
            typeof s.chainSupply === "number" && s.chainSupply > 0
              ? s.chainSupply
              : undefined,
          total: s.totalShielded,
          sprout: s.sprout ?? 0,
          sapling: s.sapling ?? 0,
          orchard: s.orchard ?? 0,
          ironwood: s.ironwood ?? 0,
          lockbox: s.lockbox ?? 0,
          transparent: s.transparent ?? 0,
          pct:
            typeof s.shieldedPercentage === "number"
              ? s.shieldedPercentage
              : 0,
          source: CIPHERSCAN_URL,
        }
      }
    }
  } catch {
    /* fall through to stale mirror */
  }

  if (breakdown) {
    if (kv) {
      const json = JSON.stringify(breakdown)
      try {
        // Two writes: short-TTL fresh cache that next requests dedupe
        // against, plus a no-TTL "last-known-good" mirror that survives
        // past the 1h fresh-cache window so a long cipherscan outage
        // doesn't blank the chip mid-day.
        await Promise.all([
          kv.put(KV_SHIELDED_KEY, json, { expirationTtl: KV_SHIELDED_TTL }),
          kv.put(KV_SHIELDED_STALE_KEY, json),
        ])
      } catch {}
    }
    return breakdown
  }

  // Upstream + fresh cache both unavailable. Serve last-known-good
  // shielded data rather than letting the chip vanish on a transient
  // cipherscan blip. The numbers move slowly (chain-level supply
  // accounting is a many-hours-stale-and-still-correct kind of metric),
  // so a stale mirror up to a day or two old is fine here.
  if (kv) {
    try {
      const stale = await kv.get(KV_SHIELDED_STALE_KEY)
      if (stale) {
        const parsed = JSON.parse(stale) as ShieldedBreakdown
        if (typeof parsed?.total === "number" && parsed.total > 0) {
          // Flag as stale so the caller prefers the live market feed's
          // circulating over this possibly days-frozen chainSupply.
          return { ...parsed, stale: true }
        }
      }
    } catch {
      /* fall through */
    }
  }
  return null
}

interface CGMarketChart {
  market_caps?: [number, number][]
  total_volumes?: [number, number][]
}

interface McapPerf {
  mcap24h: number | null
  mcap7d: number | null
  mcap30d: number | null
  /** [unix-ms, mcap-usd][] — full daily series, exposed on the route
   *  response for the Supply tab's market-cap chart. */
  series: [number, number][]
  /** Last day's total trading volume in USD (across all exchanges CG
   *  tracks). Surfaced on the new Volume tab. */
  volume24h: number | null
  /** [unix-ms, volume-usd][] — full 30-day daily volume series. Comes
   *  from the same /coins/zcash/market_chart call as `series` so we
   *  pay one upstream round-trip for both. */
  volumeSeries: [number, number][]
}

// CoinMarketCap's public chart endpoint — same source that powers
// coinmarketcap.com's price chart. Used as a backup when CoinGecko
// rate-limits our Cloudflare egress IPs (which happens often enough
// that without this the Volume / Mcap charts would just blank out).
//
// The response shape is { data: { points: { "<unix_seconds>": { v:
// [price, volume24h, mcap, btc_ratio?, btc_price?] } } } }, with
// roughly hourly-cadence points across a 1M window. We decimate to
// one point per UTC day (the most recent point within each day) so
// the series shape matches what CoinGecko returns and downstream
// code doesn't have to branch on source.
interface CMCChartResponse {
  data?: {
    points?: Record<string, { v?: number[] }>
  }
}
async function fetchMcapPerfFromCMC(): Promise<{
  series: [number, number][]
  volumeSeries: [number, number][]
}> {
  // id=1437 is Zcash on CMC; range=1M gives us ~30 days.
  const url =
    "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail/chart?id=1437&range=1M"
  try {
    const res = await fetch(url, { headers: HEADERS, cache: "no-store" })
    if (!res.ok) return { series: [], volumeSeries: [] }
    const j = (await res.json()) as CMCChartResponse
    const points = j?.data?.points
    if (!points || typeof points !== "object") {
      return { series: [], volumeSeries: [] }
    }
    // Decimate to one point per UTC day. CMC's points are unix-seconds
    // keys; bucket by `YYYY-MM-DD` and keep the latest within each.
    const byDay = new Map<string, { ts: number; v: number[] }>()
    for (const [k, p] of Object.entries(points)) {
      const v = p?.v
      if (!Array.isArray(v) || v.length < 3) continue
      const tsSec = Number(k)
      if (!Number.isFinite(tsSec)) continue
      const tsMs = tsSec * 1000
      const dayKey = new Date(tsMs).toISOString().slice(0, 10)
      const existing = byDay.get(dayKey)
      if (!existing || existing.ts < tsMs) {
        byDay.set(dayKey, { ts: tsMs, v })
      }
    }
    const ordered = Array.from(byDay.values()).sort((a, b) => a.ts - b.ts)
    // v = [price, volume24h, mcap, ...]
    const series: [number, number][] = ordered.map((p) => [p.ts, p.v[2]])
    const volumeSeries: [number, number][] = ordered.map((p) => [
      p.ts,
      p.v[1],
    ])
    return { series, volumeSeries }
  } catch {
    return { series: [], volumeSeries: [] }
  }
}

/** Pull 30 daily market-cap + volume points and compute % change for
 *  24h / 7d / 30d off the same series. CoinGecko is primary (matches
 *  the rest of the route's data); CoinMarketCap is the fallback when
 *  CG rate-limits CF egress. A long-lived KV stale mirror catches the
 *  case where both upstreams are down at the moment the 1h fresh-cache
 *  rolls over. */
async function fetchMcapPerf(kv: KVLike | null): Promise<McapPerf> {
  if (kv) {
    try {
      const cached = await kv.get(KV_MCAP_HIST_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as Partial<McapPerf>
        // Only treat the cache as "fresh enough to short-circuit on" if
        // it actually has series data — empty-from-CG-failure entries
        // shouldn't suppress a retry the way real data would.
        if (
          Array.isArray(parsed.series) &&
          parsed.series.length > 0 &&
          Array.isArray(parsed.volumeSeries) &&
          parsed.volumeSeries.length > 0
        ) {
          return {
            mcap24h: parsed.mcap24h ?? null,
            mcap7d: parsed.mcap7d ?? null,
            mcap30d: parsed.mcap30d ?? null,
            series: parsed.series,
            volume24h: parsed.volume24h ?? null,
            volumeSeries: parsed.volumeSeries,
          }
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
    volume24h: null,
    volumeSeries: [],
  }

  // Try CG, then CMC. If either succeeds, compute perf deltas + write
  // back to both the fresh cache (1h TTL) and the long-lived stale
  // mirror (no TTL).
  let series: [number, number][] = []
  let volumeSeries: [number, number][] = []
  let source: "coingecko" | "coinmarketcap" | null = null
  try {
    const cgUrl =
      "https://api.coingecko.com/api/v3/coins/zcash/market_chart?vs_currency=usd&days=30&interval=daily"
    const res = await fetch(cgUrl, { headers: HEADERS, cache: "no-store" })
    if (res.ok) {
      const j = (await res.json()) as CGMarketChart
      const cgSeries = j.market_caps ?? []
      const cgVolumes = j.total_volumes ?? []
      if (cgSeries.length >= 8 && cgVolumes.length >= 8) {
        series = cgSeries
        volumeSeries = cgVolumes
        source = "coingecko"
      }
    }
  } catch {
    /* fall through to CMC */
  }

  if (series.length === 0) {
    const cmc = await fetchMcapPerfFromCMC()
    if (cmc.series.length >= 8 && cmc.volumeSeries.length >= 8) {
      series = cmc.series
      volumeSeries = cmc.volumeSeries
      source = "coinmarketcap"
    }
  }

  // Both upstreams empty — fall back to the long-lived stale mirror
  // (last-known-good payload). The numbers are at most a day or two
  // old in the worst case, which is strictly better than rendering
  // "—" in the Volume tab.
  if (series.length === 0) {
    if (kv) {
      try {
        const stale = await kv.get(KV_MCAP_HIST_STALE_KEY)
        if (stale) {
          const parsed = JSON.parse(stale) as Partial<McapPerf>
          if (
            Array.isArray(parsed.series) &&
            parsed.series.length > 0 &&
            Array.isArray(parsed.volumeSeries) &&
            parsed.volumeSeries.length > 0
          ) {
            return {
              mcap24h: parsed.mcap24h ?? null,
              mcap7d: parsed.mcap7d ?? null,
              mcap30d: parsed.mcap30d ?? null,
              series: parsed.series,
              volume24h: parsed.volume24h ?? null,
              volumeSeries: parsed.volumeSeries,
            }
          }
        }
      } catch {
        /* fall through to empty */
      }
    }
    return empty
  }

  // Compute the same 24h / 7d / 30d percentage deltas off whichever
  // series we ended up with. CMC and CG both produce daily points, so
  // indexing-by-position is fine.
  const last = series[series.length - 1][1]
  const dayAgo = series[Math.max(0, series.length - 2)][1]
  const wkAgo = series[Math.max(0, series.length - 8)][1]
  const monAgo = series[0][1]
  const pct = (then: number) =>
    then > 0 && Number.isFinite(last) && Number.isFinite(then)
      ? ((last - then) / then) * 100
      : null
  const volume24h =
    volumeSeries.length > 0
      ? volumeSeries[volumeSeries.length - 1][1]
      : null
  const out: McapPerf = {
    mcap24h: pct(dayAgo),
    mcap7d: pct(wkAgo),
    mcap30d: pct(monAgo),
    series,
    volume24h,
    volumeSeries,
  }
  if (kv) {
    const json = JSON.stringify(out)
    try {
      // Two writes: short-TTL fresh cache + long-lived stale mirror.
      // Stale mirror has no TTL so it survives any window where both
      // CG and CMC are simultaneously failing.
      await Promise.all([
        kv.put(KV_MCAP_HIST_KEY, json, { expirationTtl: KV_MCAP_HIST_TTL }),
        kv.put(KV_MCAP_HIST_STALE_KEY, json),
      ])
    } catch {}
  }
  // Source captured for future telemetry; not surfaced on the
  // response shape yet.
  void source
  return out
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

  // 2) Fetch market data from CoinGecko, fallback CoinPaprika. CoinGecko
  //    sometimes returns a usable payload (price/mcap/rank) but a null
  //    circulating_supply for ZEC. We still try CoinPaprika for a circulating
  //    number, but must NOT discard a usable CoinGecko payload when Paprika
  //    is unavailable — otherwise the route drops into the degraded branch
  //    below (which returns before shielded is fetched) and the cipherscan
  //    chainSupply backfill never runs, defeating the very outage it covers.
  let market = await fetchCoinGecko()
  if (!market || market.circulating == null) {
    const paprika = await fetchCoinPaprika()
    // Prefer a source that actually has circulating; else keep whatever
    // usable payload we already have (CG with null circulating is fine —
    // chainSupply backfills it), falling back to paprika only if CG failed.
    market = paprika?.circulating != null ? paprika : market ?? paprika
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
        /* fall through to degraded fallback */
      }
    }
    // Both live upstreams and the stale mirror failed. Return a degraded 200
    // so the UI can render skeletons/"unavailable" chips instead of a 502 page.
    const degraded: ZecStats = {
      rank: liveLeaderboardRank ?? null,
      marketCap: null,
      price: null,
      change24h: null,
      mcapChange24h: null,
      mcapChange7d: null,
      mcapChange30d: null,
      mcapSeries: [],
      volume24h: null,
      volumeSeries: [],
      circulating: null,
      total: null,
      max: 21_000_000,
      ath: null,
      athChangePct: null,
      shielded: null,
      shieldedPct: null,
      shieldedBreakdown: null,
      shieldedSource: null,
      source: null,
      fetchedAt: Date.now(),
      stale: true,
    }
    return NextResponse.json(degraded, {
      headers: { "Cache-Control": "public, max-age=30" },
    })
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
    volume24h: mcapPerf.volume24h,
    volumeSeries: mcapPerf.volumeSeries,
    // Circulating/mined supply preference:
    //   fresh cipherscan chainSupply → live market feed → stale cipherscan
    // cipherscan's on-chain chainSupply is the ground-truth mined supply and
    // stays fresher than CoinGecko/CoinPaprika (which lag ~a day and
    // intermittently go null), so it wins when fresh. But when cipherscan is
    // down past its 1h cache, fetchShielded serves a no-TTL mirror whose
    // chainSupply can be days-frozen — in that case the live market feed is
    // fresher, so let it win and use the frozen value only as a last resort.
    // (>0 guard: a missing chainSupply must never read as 0% mined.
    //  marketCap stays the feed's own figure — the ~0.2% gap is immaterial.)
    circulating: (() => {
      const chainSupply =
        typeof shielded?.chainSupply === "number" && shielded.chainSupply > 0
          ? shielded.chainSupply
          : null
      return shielded?.stale
        ? market.circulating ?? chainSupply ?? null
        : chainSupply ?? market.circulating ?? null
    })(),
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
