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

// v3: bumped from v2 when we replaced the daily-UTC snapshot bucket
// with a rolling ring of timestamped snapshots (see below). The wire
// shape now also carries `volumeChangeWindowHours` per-exchange so the
// UI can label tooltips with the actual compare window. Bumping the
// key invalidates older payloads so nobody is served the field-shape
// from before this deploy.
const KV_KEY = "zec.exchanges.v3"
const KV_TTL_SECONDS = 10 * 60
const KV_STALE_KEY = "zec.exchanges.stale.v3"
// Single-key rolling ring of per-exchange volume snapshots. Replaces
// the earlier date-bucketed `zec.exchanges.daily.YYYYMMDD` scheme,
// which couldn't show ANY delta until the second UTC day after deploy
// — a noticeable "blank slate" gap users hit immediately after we
// shipped the feature. The ring writes one snapshot per fetch (10-min
// granularity, capped to 50min spacing so we don't append a near-
// duplicate every refresh) and reads the closest-to-T-24h snapshot
// available; on day 1, that "closest-to-24h" is whatever's oldest in
// the ring (e.g. 1h, 4h), so users see a real change immediately and
// the window converges to 24h within a day. The actual window each
// row was computed against is reported as `volumeChangeWindowHours`.
const KV_RING_KEY = "zec.exchanges.ring.v1"
const RING_MAX_ENTRIES = 30
const RING_MIN_SPACING_MS = 50 * 60 * 1000
const RING_TARGET_WINDOW_MS = 24 * 60 * 60 * 1000
const RING_MAX_AGE_MS = 30 * 60 * 60 * 1000

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
  /** Hours of history the change was computed over. ~24 once we've
   *  been live for >24h; smaller during the warm-up window right
   *  after deploy (lets the UI tooltip read e.g. "vs 4h ago" instead
   *  of misleading "vs prev day"). null whenever volumeChange24h is
   *  null. */
  volumeChangeWindowHours: number | null
}

/** Single timestamped snapshot of every venue's rolling-24h USD
 *  volume. Multiple of these stack up in a ring under
 *  `KV_RING_KEY`. */
interface RingEntry {
  /** Unix-millis when this entry was written. */
  ts: number
  /** Map of CG `market.identifier` to its rolling-24h USD volume at
   *  snapshot time. Missing keys = the venue wasn't in that fetch
   *  (e.g. zero-volume / filtered out). */
  volumes: Record<string, number>
}

interface SnapshotRing {
  /** Newest-first list of timestamped snapshots. We keep the list
   *  sorted descending by `ts` so the head is always "most recent". */
  snapshots: RingEntry[]
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
        volumeChangeWindowHours: null,
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

// ---------- Ring-snapshot helpers ------------------------------------------

/** Read the rolling-ring of volume snapshots from KV. Returns an empty
 *  ring (not null) on first-deploy / parse-failure so callers can
 *  always treat the result uniformly. */
async function readRing(kv: KVLike): Promise<SnapshotRing> {
  try {
    const raw = await kv.get(KV_RING_KEY)
    if (!raw) return { snapshots: [] }
    const parsed = JSON.parse(raw) as Partial<SnapshotRing>
    if (Array.isArray(parsed?.snapshots)) {
      // Defensive: filter malformed entries; sort newest-first.
      const valid = parsed.snapshots.filter(
        (s): s is RingEntry =>
          typeof s?.ts === "number" &&
          s.volumes != null &&
          typeof s.volumes === "object"
      )
      valid.sort((a, b) => b.ts - a.ts)
      return { snapshots: valid }
    }
  } catch {
    /* fall through */
  }
  return { snapshots: [] }
}

/** Pick the entry whose `ts` is closest to "now - 24h". Falls back to
 *  the OLDEST entry if nothing is within the [22h, 26h] preferred
 *  window — that path is hit during the first day after deploy, when
 *  the ring is still warming up and the closest-to-24h snapshot is
 *  e.g. only 4h old. Returns null if the ring is empty. */
function pickReferenceEntry(ring: SnapshotRing, now: number): RingEntry | null {
  if (ring.snapshots.length === 0) return null
  const target = now - RING_TARGET_WINDOW_MS
  // Preferred band: ±2h around the 24h target.
  const TOLERANCE_MS = 2 * 60 * 60 * 1000
  const inBand = ring.snapshots.filter(
    (s) =>
      Math.abs(s.ts - target) <= TOLERANCE_MS && s.ts <= now - 30 * 60 * 1000
  )
  if (inBand.length > 0) {
    inBand.sort((a, b) => Math.abs(a.ts - target) - Math.abs(b.ts - target))
    return inBand[0]
  }
  // Warm-up fallback: use the oldest entry in the ring (provided it's
  // at least 30min old, so we don't compare against a near-duplicate
  // of the current snapshot).
  const eligible = ring.snapshots.filter((s) => s.ts <= now - 30 * 60 * 1000)
  if (eligible.length === 0) return null
  // Snapshots are sorted newest-first; the last element is oldest.
  return eligible[eligible.length - 1]
}

/** Mutate `byExchange` in place to carry `volumeChange24h` +
 *  `volumeChangeWindowHours` derived from the ring. Items absent from
 *  the reference entry (newly-listed venues, zero-volume in the
 *  reference snapshot, etc.) keep both fields null, which the UI
 *  renders as a dash. */
function applyVolumeChange(
  byExchange: ZecExchangeAgg[],
  ring: SnapshotRing,
  now: number
): void {
  const ref = pickReferenceEntry(ring, now)
  if (!ref) return
  const windowHours = (now - ref.ts) / (60 * 60 * 1000)
  for (const ex of byExchange) {
    const prevVol = ref.volumes[ex.exchangeId]
    if (typeof prevVol === "number" && prevVol > 0) {
      ex.volumeChange24h = ((ex.volumeUsd24h - prevVol) / prevVol) * 100
      ex.volumeChangeWindowHours = windowHours
    }
  }
}

/** Build a fresh ring entry from the current per-exchange data. */
function buildRingEntry(byExchange: ZecExchangeAgg[], now: number): RingEntry {
  const volumes: Record<string, number> = {}
  for (const ex of byExchange) {
    volumes[ex.exchangeId] = ex.volumeUsd24h
  }
  return { ts: now, volumes }
}

/** Append `next` to the ring and prune. Caps total entries (so a single
 *  KV value can't grow unboundedly) AND drops anything older than
 *  `RING_MAX_AGE_MS` (so the ring's tail stays useful — entries older
 *  than ~30h are never picked as references and just take up space).
 *  Skips the append if the head is more recent than `RING_MIN_SPACING_MS`,
 *  which prevents 6-near-duplicates-per-hour noise from the SWR refresh
 *  cadence. */
function pushToRing(ring: SnapshotRing, next: RingEntry): SnapshotRing {
  const head = ring.snapshots[0]
  if (head && next.ts - head.ts < RING_MIN_SPACING_MS) {
    return ring
  }
  const merged: RingEntry[] = [next, ...ring.snapshots]
  const cutoff = next.ts - RING_MAX_AGE_MS
  const pruned = merged
    .filter((s) => s.ts >= cutoff)
    .slice(0, RING_MAX_ENTRIES)
  return { snapshots: pruned }
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

  const now = Date.now()
  const { markets, total24hVolumeUsd } = normaliseTickers(tickers)
  const byExchange = aggregateByExchange(markets, total24hVolumeUsd)
  const byPair = aggregateByPair(markets, total24hVolumeUsd)

  // Per-exchange % change driven by the rolling-ring snapshot. The
  // ring is populated incrementally on every fetch (with 50-min min
  // spacing — see pushToRing), so:
  //   - First fetch ever (empty ring): all venues stay null. UI shows
  //     dashes. Then we write the first snapshot below; the SECOND
  //     fetch (>=50min later) starts surfacing real deltas.
  //   - During warm-up (<24h of history): we compare against the
  //     OLDEST entry in the ring; volumeChangeWindowHours reports the
  //     actual window so the UI can label tooltips honestly.
  //   - Steady state (>=24h history): we compare against the entry
  //     closest to now-24h within a ±2h band — clean day-over-day.
  let ring: SnapshotRing = { snapshots: [] }
  if (kv) {
    ring = await readRing(kv)
    applyVolumeChange(byExchange, ring, now)
  }

  const payload: ZecExchangesResponse = {
    total24hVolumeUsd,
    marketCount: markets.length,
    exchangeCount: byExchange.length,
    markets,
    byExchange,
    byPair,
    source: "coingecko",
    fetchedAt: now,
  }

  // 3) Persist: fresh cache + long-lived stale mirror + the appended
  //    ring. We push-then-write the ring even on the first deploy so
  //    the very next fetch (50min later, after RING_MIN_SPACING_MS)
  //    can produce its first delta. Three independent writes; ring
  //    write failing is non-fatal — the next successful fetch will
  //    re-attempt.
  if (kv) {
    const json = JSON.stringify(payload)
    const nextRing = pushToRing(ring, buildRingEntry(byExchange, now))
    const writes: Promise<unknown>[] = [
      kv.put(KV_KEY, json, { expirationTtl: KV_TTL_SECONDS }),
      kv.put(KV_STALE_KEY, json),
    ]
    // Skip the ring write when pushToRing decided to no-op (head too
    // recent); avoids burning a write budget on identical bytes.
    if (nextRing !== ring) {
      writes.push(kv.put(KV_RING_KEY, JSON.stringify(nextRing)))
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
