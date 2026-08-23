import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { etNow, windowsForEtDate, type MarketSession } from "@/lib/market-session"
import type {
  CyphDepthBook,
  CyphDepthLevel,
  CyphDepthResponse,
} from "@/components/api-types"

// Real CYPH depth of book — ten price levels a side, per trading session.
//
// ---------------------------------------------------------------------------
// Where this comes from, and why it is T+1
// ---------------------------------------------------------------------------
// US equity depth of book is a licensed exchange product, so unlike the ZEC
// surfaces there is no public REST endpoint to poll. Databento resells it,
// and two of their datasets between them cover every session CYPH trades in:
//
//   XNAS.ITCH    Nasdaq TotalView-ITCH. Nasdaq's own book, and its system
//                hours are 04:00-20:00 ET, so this covers pre-market,
//                regular hours AND after-hours depth.
//   OCEA.MEMOIR  Blue Ocean ATS. The overnight venue, 20:00-04:00 ET.
//
// Databento's live feed is a persistent DBN stream, which a Worker cannot
// hold, and their historical API embargoes data for 24 hours. So this route
// serves the LAST COMPLETED session rather than a live book, and says so.
// That is a real limitation and the UI states it rather than dressing a
// day-old book up as live. Live depth would need a always-on bridge process
// holding the stream and maintaining the book, the same shape as the Binance
// bridge behind /api/zec-depth.
//
// The upside of the embargo is that everything here is IMMUTABLE once
// published: a session's closing book never changes. So it is cached hard,
// keyed by session date, and a given session is fetched exactly once ever.
// At roughly $0.007 for a full day of CYPH MBP-10 that keeps the running
// cost to about a cent a day even before the cache.
//
// ---------------------------------------------------------------------------
// "Closing book" and how it is found
// ---------------------------------------------------------------------------
// Each session is represented by the last MBP-10 record inside it — where the
// book stood as that session ended. Databento can only page forward, so the
// last record is found by querying a narrow window at the session's end and
// widening only if it came back empty. Active sessions resolve on the first,
// narrowest query; a quiet overnight session may need the whole window, which
// is cheap precisely because it was quiet.

export const dynamic = "force-dynamic"

const HIST = "https://hist.databento.com/v0"
const XNAS = "XNAS.ITCH"
const OCEA = "OCEA.MEMOIR"

/** Databento prices are fixed-point with nine implied decimals. */
const PRICE_SCALE = 1e9
/** DBN's null sentinel for an absent price is INT64_MAX. A level padded with
 *  it is "this side of the book is not that deep", not a real price — reading
 *  it as a number would put an ask at $9.2 billion. */
const NULL_PRICE = "9223372036854775807"

/** Windows to try at the end of a session, newest-narrowest first. Each entry
 *  is how far back from the session close to start looking. */
const CLOSING_WINDOWS_MS = [5 * 60_000, 60 * 60_000, Infinity]

const SOURCE_TIMEOUT_MS = 12_000
const FRESH_TTL_MS = 5 * 60_000
const EDGE_TTL_SECONDS = 300
/** A published session never changes, so the mirror can live a long time.
 *  Keyed by session date, so a new day is a new key rather than an
 *  overwrite. */
const KV_TTL_SECONDS = 7 * 24 * 60 * 60
const KV_PREFIX = "cyph.depth.v1"

const RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": `public, max-age=0, s-maxage=${EDGE_TTL_SECONDS}`,
}

const DATABENTO_KEY_ENV = "DATABENTO_API_KEY"

// ---------- Secrets / env -------------------------------------------------

async function getSecret(name: string): Promise<string | null> {
  try {
    const ctx = await getCloudflareContext({ async: true })
    const v = (ctx?.env as Record<string, unknown> | undefined)?.[name]
    if (typeof v === "string" && v.length > 0) return v
  } catch {
    /* fall through to process.env */
  }
  const p = process.env[name]
  return typeof p === "string" && p.length > 0 ? p : null
}

// ---------- Databento -----------------------------------------------------

function authHeader(key: string): string {
  // Databento uses HTTP Basic with the API key as the username and an empty
  // password. btoa is available in workerd and in Node 18+.
  return `Basic ${btoa(`${key}:`)}`
}

async function databento(
  key: string,
  path: string,
  params: Record<string, string>
): Promise<string> {
  const url = new URL(`${HIST}/${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), {
    headers: { Authorization: authHeader(key), Accept: "*/*" },
    cache: "no-store",
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`Databento ${path}: ${res.status}`)
  }
  return res.text()
}

/** How long a published-through reading is trusted before we ask upstream
 *  again. Depth publishes once a day, so re-asking per request bought nothing
 *  and cost a round trip on every KV-served hit — measured under workerd, a
 *  mirror hit came back SLOWER than a cold build because of it. Ten minutes
 *  still notices a publish promptly while collapsing the check to at most one
 *  call per instance per window. */
const PUBLISHED_THROUGH_TTL_MS = 10 * 60_000

let publishedThroughCache: { dataset: string; end: number | null; at: number } | null =
  null

/** Latest instant Databento has published for a dataset. Memoised per
 *  instance — see PUBLISHED_THROUGH_TTL_MS. */
async function datasetEnd(key: string, dataset: string): Promise<number | null> {
  const now = Date.now()
  if (
    publishedThroughCache &&
    publishedThroughCache.dataset === dataset &&
    now - publishedThroughCache.at < PUBLISHED_THROUGH_TTL_MS
  ) {
    return publishedThroughCache.end
  }
  const raw = await databento(key, "metadata.get_dataset_range", { dataset })
  const parsed = JSON.parse(raw) as { end?: string }
  const ms = typeof parsed.end === "string" ? Date.parse(parsed.end) : NaN
  const end = Number.isFinite(ms) ? ms : null
  publishedThroughCache = { dataset, end, at: now }
  return end
}

function price(raw: unknown): number | null {
  if (typeof raw !== "string" || raw === NULL_PRICE) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return n / PRICE_SCALE
}

function size(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

interface RawLevel {
  bid_px?: unknown
  ask_px?: unknown
  bid_sz?: unknown
  ask_sz?: unknown
  bid_ct?: unknown
  ask_ct?: unknown
}

interface RawRecord {
  ts_recv?: unknown
  hd?: { ts_event?: unknown }
  levels?: RawLevel[]
}

/** Last complete JSON record in an NDJSON body, or null when empty. */
function lastRecord(body: string): RawRecord | null {
  const lines = body.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      return JSON.parse(line) as RawRecord
    } catch {
      // A truncated final line is the only expected parse failure; keep
      // walking back to the last one that is whole.
    }
  }
  return null
}

/** Nanosecond epoch string to ms. */
function nsToMs(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN
  // Floor rather than round: `at` is "the last update at or before the close",
  // and rounding a 23:59:59.9995 stamp up would put it a millisecond past the
  // session boundary it is meant to sit inside.
  return Number.isFinite(n) ? Math.floor(n / 1e6) : null
}

/** Prices arrive as exact integers scaled by 1e9, but differencing two of
 *  them in floating point does not stay exact — a 2c spread came out as
 *  0.019999999999999796. Snap price-derived arithmetic back to a sane number
 *  of decimals so the wire format carries a price, not its float residue. */
function roundPrice(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

function normalise(
  session: MarketSession,
  venue: "XNAS" | "OCEA",
  rec: RawRecord,
  windowStart: number,
  windowEnd: number
): CyphDepthBook | null {
  const rawLevels = Array.isArray(rec.levels) ? rec.levels : []
  const levels: CyphDepthLevel[] = rawLevels.map((l) => ({
    bidPx: price(l.bid_px),
    bidSz: size(l.bid_sz),
    bidCt: size(l.bid_ct),
    askPx: price(l.ask_px),
    askSz: size(l.ask_sz),
    askCt: size(l.ask_ct),
  }))
  // A record whose every level is the null sentinel carries no book at all
  // (it happens right at a venue's open, before any order rests). Reporting
  // it as an empty book is more honest than reporting a mid of null with ten
  // zero rows, but it is not a book, so drop it.
  const populated = levels.filter((l) => l.bidPx != null || l.askPx != null)
  if (populated.length === 0) return null

  const bestBid = levels[0]?.bidPx ?? null
  const bestAsk = levels[0]?.askPx ?? null
  const mid =
    bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk)
  const spread =
    bestBid != null && bestAsk != null ? roundPrice(bestAsk - bestBid) : null

  let bidShares = 0
  let askShares = 0
  let bidNotional = 0
  let askNotional = 0
  for (const l of levels) {
    if (l.bidPx != null) {
      bidShares += l.bidSz
      bidNotional += l.bidPx * l.bidSz
    }
    if (l.askPx != null) {
      askShares += l.askSz
      askNotional += l.askPx * l.askSz
    }
  }
  const totalShares = bidShares + askShares

  return {
    session,
    venue,
    at: nsToMs(rec.ts_recv) ?? nsToMs(rec.hd?.ts_event) ?? windowEnd,
    windowStart,
    windowEnd,
    levels,
    bestBid,
    bestAsk,
    mid: mid != null ? roundPrice(mid) : null,
    spread,
    spreadBps: spread != null && mid != null && mid > 0 ? (spread / mid) * 10_000 : null,
    bidShares,
    askShares,
    bidNotional: roundPrice(bidNotional),
    askNotional: roundPrice(askNotional),
    // Positive = more resting size on the bid than the offer across the ten
    // levels we can see. Deliberately shares-based, not notional: at a
    // ten-level horizon the two are within a rounding error of each other on
    // a $1 stock, and shares are what the levels are actually quoted in.
    imbalancePct: totalShares > 0 ? ((bidShares - askShares) / totalShares) * 100 : null,
  }
}

/** The closing book for one session, or null when the venue saw no resting
 *  book in it at all. */
async function closingBook(
  key: string,
  session: MarketSession,
  dataset: string,
  venue: "XNAS" | "OCEA",
  start: number,
  end: number
): Promise<CyphDepthBook | null> {
  for (const back of CLOSING_WINDOWS_MS) {
    const from = back === Infinity ? start : Math.max(start, end - back)
    if (from >= end) continue
    let body: string
    try {
      body = await databento(key, "timeseries.get_range", {
        dataset,
        symbols: "CYPH",
        stype_in: "raw_symbol",
        schema: "mbp-10",
        encoding: "json",
        start: new Date(from).toISOString(),
        end: new Date(end).toISOString(),
      })
    } catch {
      // A failure on the narrow window is worth retrying wider — but a
      // failure on the widest is the end of the road for this session.
      continue
    }
    const rec = lastRecord(body)
    if (!rec) continue
    const book = normalise(session, venue, rec, from, end)
    if (book) return book
  }
  return null
}

/** Which sessions to ask for, given the ET date whose sessions have fully
 *  published. PRE/REGULAR/AFTER come off that date; the overnight session
 *  that fed INTO it started the previous evening, so it is taken from the
 *  day before — `windowsForEtDate` attributes an overnight window to the
 *  evening it opens, not the morning it closes. */
function sessionPlan(target: { year: number; month: number; day: number }) {
  const d = new Date(Date.UTC(target.year, target.month - 1, target.day))
  const dow = d.getUTCDay()
  const prev = new Date(Date.UTC(target.year, target.month - 1, target.day - 1))

  const today = windowsForEtDate(target.year, target.month, target.day, dow)
  const yesterday = windowsForEtDate(
    prev.getUTCFullYear(),
    prev.getUTCMonth() + 1,
    prev.getUTCDate(),
    prev.getUTCDay()
  )

  const plan: {
    session: MarketSession
    dataset: string
    venue: "XNAS" | "OCEA"
    start: number
    end: number
  }[] = []

  const overnight = yesterday.find((w) => w.session === "OVERNIGHT")
  if (overnight) {
    plan.push({
      session: "OVERNIGHT",
      dataset: OCEA,
      venue: "OCEA",
      start: overnight.start,
      end: overnight.end,
    })
  }
  for (const s of ["PRE", "REGULAR", "AFTER"] as const) {
    const w = today.find((x) => x.session === s)
    if (w) {
      plan.push({ session: s, dataset: XNAS, venue: "XNAS", start: w.start, end: w.end })
    }
  }
  return plan
}

async function build(key: string): Promise<CyphDepthResponse | null> {
  const end = await datasetEnd(key, XNAS)
  if (end == null) return null

  // `end` is exclusive and lands on a session boundary (Nasdaq's 20:00 ET
  // close reads as the next day 00:00Z), so step back inside the published
  // range before asking which ET date it belongs to. An hour is comfortably
  // more than the boundary skew and comfortably less than a session.
  const inside = etNow(new Date(end - 60 * 60_000))
  if (!inside) return null

  const plan = sessionPlan(inside)
  const books = await Promise.all(
    plan.map((p) =>
      closingBook(key, p.session, p.dataset, p.venue, p.start, p.end).catch(() => null)
    )
  )
  const sessions = books.filter((b): b is CyphDepthBook => b != null)
  if (sessions.length === 0) return null

  return {
    fetchedAt: Date.now(),
    sessionDate: `${inside.year}-${String(inside.month).padStart(2, "0")}-${String(inside.day).padStart(2, "0")}`,
    publishedThrough: end,
    sessions,
    sessionsOk: sessions.length,
    sessionsTotal: plan.length,
  }
}

// ---------- Caches --------------------------------------------------------

interface KVLike {
  get: (k: string) => Promise<string | null>
  put: (k: string, v: string, o?: { expirationTtl?: number }) => Promise<void>
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

interface EdgeCache {
  match: (req: Request) => Promise<Response | undefined>
  put: (req: Request, res: Response) => Promise<void>
}

function edgeCache(): EdgeCache | null {
  return (globalThis as { caches?: { default?: EdgeCache } }).caches?.default ?? null
}

function cacheKey(request: Request): Request | null {
  try {
    return new Request(new URL("/api/cyph-depth", request.url).toString(), {
      method: "GET",
    })
  } catch {
    return null
  }
}

let lastSnapshot: CyphDepthResponse | null = null
let inFlight: Promise<CyphDepthResponse | null> | null = null

export async function GET(request: Request) {
  const now = Date.now()

  if (lastSnapshot && now - lastSnapshot.fetchedAt < FRESH_TTL_MS) {
    return NextResponse.json(lastSnapshot, { headers: RESPONSE_HEADERS })
  }

  const cache = edgeCache()
  const key = cache ? cacheKey(request) : null
  if (cache && key) {
    try {
      const hit = await cache.match(key)
      if (hit) {
        return new Response(hit.body, {
          status: hit.status,
          statusText: hit.statusText,
          headers: RESPONSE_HEADERS,
        })
      }
    } catch {
      /* treat a cache error as a miss */
    }
  }

  const apiKey = await getSecret(DATABENTO_KEY_ENV)
  const kv = await getKV()

  // Which session date we are serving is itself a Databento lookup, so the
  // KV read can't be keyed by date before we know it. Read the pointer key
  // first: it names the newest session we have already built.
  if (kv) {
    try {
      const pointer = await kv.get(`${KV_PREFIX}.latest`)
      if (pointer) {
        const raw = await kv.get(`${KV_PREFIX}.${pointer}`)
        if (raw) {
          const parsed = JSON.parse(raw) as CyphDepthResponse
          // A cached session is only the answer while it is still the newest
          // one. Past that the pointer will have moved; if we have no key at
          // all we must build. `publishedThrough` tells us whether Databento
          // has moved on, and we re-check that at most once per FRESH_TTL_MS
          // thanks to the tiers above.
          if (Number.isFinite(parsed.fetchedAt) && parsed.sessions?.length) {
            const stillCurrent =
              apiKey == null ||
              (await datasetEnd(apiKey, XNAS).catch(() => null)) ===
                parsed.publishedThrough
            if (stillCurrent) {
              lastSnapshot = parsed
              return NextResponse.json(parsed, { headers: RESPONSE_HEADERS })
            }
          }
        }
      }
    } catch {
      /* unreadable mirror — fall through and build */
    }
  }

  if (!apiKey) {
    return NextResponse.json(
      {
        error: `CYPH depth needs the ${DATABENTO_KEY_ENV} binding`,
        needsKey: true,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }

  if (!inFlight) {
    inFlight = build(apiKey).finally(() => {
      inFlight = null
    })
  }
  let fresh: CyphDepthResponse | null = null
  try {
    fresh = await inFlight
  } catch {
    fresh = null
  }

  if (fresh) {
    lastSnapshot = fresh
    const body = JSON.stringify(fresh)
    if (cache && key) {
      try {
        await cache.put(
          key,
          new Response(body, {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": `public, max-age=0, s-maxage=${EDGE_TTL_SECONDS}`,
            },
          })
        )
      } catch {
        /* a cache write failure must not fail the request */
      }
    }
    if (kv) {
      try {
        await kv.put(`${KV_PREFIX}.${fresh.sessionDate}`, body, {
          expirationTtl: KV_TTL_SECONDS,
        })
        await kv.put(`${KV_PREFIX}.latest`, fresh.sessionDate, {
          expirationTtl: KV_TTL_SECONDS,
        })
      } catch {
        /* mirror write is best-effort */
      }
    }
    return new Response(body, { headers: RESPONSE_HEADERS })
  }

  return NextResponse.json(
    { error: "CYPH depth unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  )
}
