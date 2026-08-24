import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import type {
  CyphLevel1,
  CyphFlowResponse,
  CyphFlowSession,
  CyphFlowSessionId,
  CyphPrint,
  CyphPriceLevel,
} from "@/components/api-types"

// CYPH order flow, per trading session.
//
// ---------------------------------------------------------------------------
// Why this is flow and not a book
// ---------------------------------------------------------------------------
// The ZEC surfaces show a real order book because crypto exchanges publish
// full L2 depth over public REST. US equities do not: the depth of book is a
// licensed exchange product. For CYPH the honest free ceiling is the *tape* —
// executed prints — plus each session's official aggregate. So this endpoint
// serves flow (what traded, at what price, in what size) rather than resting
// liquidity, and the UI is labelled accordingly. Nothing here is presented as
// bid/ask depth, because none of it is.
//
// Nasdaq's own public quote API is the source. It carries three things worth
// having, none of which needs a key:
//
//   • `extended-trading?markettype=pre|post` — the pre-market and after-hours
//     tapes, plus that session's official consolidated volume, high and low.
//     This is the good one: CYPH routinely trades a third of its daily volume
//     after the close, and that flow is invisible on a daily candle.
//   • `realtime-trades` — the regular-session NLS tape.
//
// ---------------------------------------------------------------------------
// What "sampled" means, and why it is on every session
// ---------------------------------------------------------------------------
// Every tape endpoint returns the most recent ~100 prints, not the session.
// On an active day that can span well under a minute, so a histogram built
// from it describes the last hundred trades and NOT where the session's
// volume actually sat. Nasdaq also buckets the tape into 30-minute slices,
// but each slice caps at 100 prints too, so paging them still cannot
// reconstruct a busy session — it just multiplies the requests.
//
// Rather than quietly present a biased sample as a volume profile, the tape
// is fetched once per session and flagged `sampled`, and the session
// aggregate (volume / high / low), which IS complete and official, is carried
// alongside it. The UI leans on the aggregate for "how big was this session"
// and on the tape for "what is happening right now".
//
// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------
// Three tiers, same shape as /api/zec-depth but slower, because a stock tape
// does not move like a crypto book and this is someone else's free endpoint:
//   • 20 s per-instance memory cache, with in-flight joining so a slow
//     upstream cannot let every poll start its own fan-out.
//   • 20 s per-colo cache. Workers do not cache their own responses, so
//     without this the `s-maxage` header would do nothing at all.
//   • A 30-minute KV mirror for a cold colo and for total upstream failure.
// Three upstream calls per 20 s per colo is a polite ceiling for a public
// endpoint we are not paying for.

export const dynamic = "force-dynamic"

const FRESH_TTL_MS = 20_000
const EDGE_TTL_SECONDS = 20
const KV_KEY = "cyph.flow.v1"
const KV_TTL_SECONDS = 30 * 60
/** How old the mirror may be and still be served as the live answer, rather
 *  than only as the failure fallback. */
const KV_WARM_TTL_MS = 20_000
const SOURCE_TIMEOUT_MS = 7_000

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
const NASDAQ_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/market-activity/stocks/cyph",
}

const RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": `public, max-age=0, s-maxage=${EDGE_TTL_SECONDS}`,
}

// ---------- Parsing -------------------------------------------------------
//
// Every field on this API is a display string built for a web page — "$1.42",
// "6,089,936", "$1.8 (07:20:37 PM)", "$1.6208 +0.4308 (+36.20%)". None of it
// is typed, and any of it can be "N/A" or absent depending on session.

/** First number in a display string, ignoring $ , % and sign decoration.
 *  Returns null for "N/A", "", "--" and anything else unparseable. */
function num(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null
  if (typeof raw !== "string") return null
  const m = raw.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

/** Signed number, preserving a leading + or - that `num` would also catch but
 *  which we want to be explicit about for change fields. */
function signedNum(raw: unknown): number | null {
  if (typeof raw !== "string") return num(raw)
  const m = raw.replace(/,/g, "").match(/[-+]?\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

/** Parenthesised clock stamp on the session high/low fields:
 *  "$1.8 (07:20:37 PM)" -> "07:20:37 PM". */
function bracketTime(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const m = raw.match(/\(([^)]+)\)/)
  return m ? m[1].trim() : null
}

/** "$1.6208 +0.4308 (+36.20%)" -> last / change / changePct. Any component
 *  may be missing; the string is often just "$1.42" or null. */
function parseConsolidated(raw: unknown): {
  last: number | null
  change: number | null
  changePct: number | null
} {
  if (typeof raw !== "string") return { last: null, change: null, changePct: null }
  const pctMatch = raw.match(/\(\s*([-+]?\d+(?:\.\d+)?)\s*%\s*\)/)
  const changePct = pctMatch ? Number(pctMatch[1]) : null
  // Strip the parenthesised percent before reading the bare numbers, so the
  // percent can't be mistaken for the change.
  const head = raw.replace(/\([^)]*\)/g, " ")
  const nums = head.replace(/,/g, "").match(/[-+]?\d+(?:\.\d+)?/g) ?? []
  return {
    last: nums[0] != null ? Number(nums[0]) : null,
    change: nums[1] != null ? Number(nums[1]) : null,
    changePct: changePct != null && Number.isFinite(changePct) ? changePct : null,
  }
}

/** Normalise one tape row. Nasdaq's key names differ per endpoint
 *  (`time`/`price`/`shareVolume` on extended-trading, NLS-prefixed variants
 *  on realtime-trades) and are not documented, so match on what the key
 *  means rather than on an exact spelling. An unrecognised shape yields null
 *  and is dropped instead of becoming a row of nulls on screen. */
function parsePrintRow(row: unknown): { time: string; price: number; size: number } | null {
  if (!row || typeof row !== "object") return null
  const entries = Object.entries(row as Record<string, unknown>)
  let time: string | null = null
  let price: number | null = null
  let size: number | null = null
  for (const [k, v] of entries) {
    const key = k.toLowerCase()
    if (time == null && /time/.test(key) && typeof v === "string" && /\d/.test(v)) {
      time = v.trim()
    } else if (price == null && /price/.test(key)) {
      price = num(v)
    } else if (size == null && /volume|size|share/.test(key)) {
      size = num(v)
    }
  }
  if (!time || price == null || price <= 0 || size == null || size <= 0) return null
  return { time, price, size }
}

/** Tick direction per print, by the standard tick rule: compare each print to
 *  the most recent *different* price before it. Rows arrive newest-first, so
 *  we walk them oldest-first and then restore the original order.
 *
 *  A repeat at the same price inherits the last known direction (a "zero
 *  tick"), which is what the rule actually says — dropping it would throw
 *  away most of the volume on a thin book where runs of identical prints are
 *  the norm. */
function withTicks(rows: { time: string; price: number; size: number }[]): CyphPrint[] {
  const oldestFirst = [...rows].reverse()
  let lastPrice: number | null = null
  let lastDir: "up" | "down" | null = null
  const out: CyphPrint[] = oldestFirst.map((r) => {
    let tick: "up" | "down" | null = lastDir
    if (lastPrice != null) {
      if (r.price > lastPrice) tick = "up"
      else if (r.price < lastPrice) tick = "down"
    } else {
      tick = null
    }
    lastPrice = r.price
    lastDir = tick
    return { time: r.time, price: r.price, size: r.size, tick }
  })
  return out.reverse()
}

/** Volume by price over the prints we hold, split by tick direction so the UI
 *  can show which side of the tape each level was worked from. Sorted high
 *  price first, which is how a depth ladder reads. */
function priceLevels(prints: CyphPrint[]): CyphPriceLevel[] {
  const byPrice = new Map<number, CyphPriceLevel>()
  for (const p of prints) {
    const key = Math.round(p.price * 10_000) / 10_000
    const at = byPrice.get(key) ?? { price: key, size: 0, upSize: 0, downSize: 0 }
    at.size += p.size
    if (p.tick === "up") at.upSize += p.size
    else if (p.tick === "down") at.downSize += p.size
    byPrice.set(key, at)
  }
  return [...byPrice.values()].sort((a, b) => b.price - a.price)
}

// ---------- Upstream ------------------------------------------------------

async function nasdaq(path: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS)
  try {
    const res = await fetch(`https://api.nasdaq.com/api/quote/CYPH/${path}`, {
      headers: NASDAQ_HEADERS,
      cache: "no-store",
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Nasdaq ${path}: ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function rowsOf(table: unknown): unknown[] {
  const t = table as { rows?: unknown } | null | undefined
  return Array.isArray(t?.rows) ? (t.rows as unknown[]) : []
}

/** The pre-market / after-hours session. `markettype=overnight` exists on the
 *  same endpoint but returns an empty object for CYPH — Blue Ocean's ATS flow
 *  is not published here at all — so overnight is deliberately not requested.
 *  The dashboard still surfaces the overnight *price* from /api/quote. */
async function fetchExtended(
  session: Extract<CyphFlowSessionId, "PRE" | "POST">
): Promise<CyphFlowSession> {
  const markettype = session === "PRE" ? "pre" : "post"
  const json = (await nasdaq(
    `extended-trading?assetclass=stocks&markettype=${markettype}&time=0`
  )) as {
    data?: {
      infoTable?: unknown
      tradeDetailTable?: unknown
      lastUpdateInfo?: unknown
      previousInfo?: unknown
    }
    message?: unknown
  }
  const data = json?.data
  if (!data) throw new Error(`Nasdaq ${markettype}: empty payload`)

  const info = (rowsOf(data.infoTable)[0] ?? {}) as Record<string, unknown>
  const consolidated = parseConsolidated(info.consolidated)
  const prints = withTicks(
    rowsOf(data.tradeDetailTable)
      .map(parsePrintRow)
      .filter((r): r is { time: string; price: number; size: number } => r != null)
  )
  const asOf = Array.isArray(data.lastUpdateInfo)
    ? (data.lastUpdateInfo.find((l) => typeof l === "string") as string | undefined) ?? null
    : null

  return {
    session,
    last: consolidated.last,
    change: consolidated.change,
    changePct: consolidated.changePct,
    volume: num(info.volume),
    high: num(info.highPrice),
    low: num(info.lowPrice),
    highAt: bracketTime(info.highPrice),
    lowAt: bracketTime(info.lowPrice),
    prints,
    levels: priceLevels(prints),
    sampled: prints.length > 0,
    asOf,
    message: typeof json.message === "string" ? json.message : null,
  }
}

/** Regular-session NLS tape. Nasdaq gates this one harder than the extended
 *  tapes — outside market hours it answers 200 with an empty row set and
 *  "Real-Time trades not available" — so an empty tape here is normal and not
 *  an error. The `topTable` aggregate (session volume, previous close, day
 *  high/low) is populated either way and is the part worth keeping. */
async function fetchRegular(): Promise<{
  session: CyphFlowSession
  previousClose: number | null
}> {
  const json = (await nasdaq("realtime-trades?&limit=100")) as {
    data?: { rows?: unknown; topTable?: unknown; message?: unknown }
    message?: unknown
  }
  const data = json?.data
  if (!data) throw new Error("Nasdaq realtime-trades: empty payload")

  const top = (rowsOf(data.topTable)[0] ?? {}) as Record<string, unknown>
  const prints = withTicks(
    (Array.isArray(data.rows) ? data.rows : [])
      .map(parsePrintRow)
      .filter((r): r is { time: string; price: number; size: number } => r != null)
  )
  // "$1.45/$1.185" — high first, then low.
  const range = typeof top.todayHighLow === "string" ? top.todayHighLow : ""
  const rangeNums = (range.replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number)
  const asOf = Array.isArray(data.message)
    ? (data.message.find((l) => typeof l === "string") as string | undefined) ?? null
    : null

  return {
    previousClose: num(top.previousClose),
    session: {
      session: "REGULAR",
      last: prints[0]?.price ?? null,
      change: null,
      changePct: null,
      volume: num(top.nlsVolume),
      high: rangeNums[0] ?? null,
      low: rangeNums[1] ?? null,
      highAt: null,
      lowAt: null,
      prints,
      levels: priceLevels(prints),
      sampled: prints.length > 0,
      asOf,
      message: typeof json.message === "string" ? json.message : null,
    },
  }
}

/** Live top-of-book. The `info` endpoint carries bid/ask and their sizes
 *  alongside the last sale, and asserts its own real-time status — which is
 *  true during a session and false outside one, where the same fields
 *  describe the previous close. Reported as given rather than inferred from
 *  our own clock, so a stale upstream cannot read as live. */
async function fetchLevel1(): Promise<CyphLevel1 | null> {
  const json = (await nasdaq("info?assetclass=stocks")) as {
    data?: {
      marketStatus?: unknown
      primaryData?: Record<string, unknown>
    }
  }
  const d = json?.data
  const p = d?.primaryData
  if (!p) return null
  const bid = num(p.bidPrice)
  const ask = num(p.askPrice)
  const last = num(p.lastSalePrice)
  // Nothing usable — a payload of four nulls is worse than saying no, because
  // the UI would render an empty live row instead of falling back.
  if (bid == null && ask == null && last == null) return null
  return {
    bid,
    ask,
    bidSize: num(p.bidSize),
    askSize: num(p.askSize),
    last,
    marketStatus: typeof d?.marketStatus === "string" ? d.marketStatus : null,
    asOf: typeof p.lastTradeTimestamp === "string" ? p.lastTradeTimestamp : null,
    isRealTime: p.isRealTime === true || p.isRealTime === "true",
  }
}

async function build(now: number): Promise<CyphFlowResponse | null> {
  const [pre, regular, post, l1] = await Promise.allSettled([
    fetchExtended("PRE"),
    fetchRegular(),
    fetchExtended("POST"),
    fetchLevel1(),
  ])
  const level1 = l1.status === "fulfilled" ? l1.value : null

  const sessions: CyphFlowSession[] = []
  if (pre.status === "fulfilled") sessions.push(pre.value)
  if (regular.status === "fulfilled") sessions.push(regular.value.session)
  if (post.status === "fulfilled") sessions.push(post.value)

  // Nothing answered — publishing an all-empty payload with a fresh
  // `fetchedAt` would render as live. Let the caller fall through to the
  // mirror, which at least reports its real age. A live quote on its own is
  // still worth publishing: it is the freshest thing here, and the tape
  // failing is no reason to withhold it.
  if (sessions.length === 0 && !level1) return null

  const order: CyphFlowSessionId[] = ["PRE", "REGULAR", "POST"]
  sessions.sort((a, b) => order.indexOf(a.session) - order.indexOf(b.session))

  return {
    fetchedAt: now,
    previousClose:
      regular.status === "fulfilled" ? regular.value.previousClose : null,
    sessions,
    sourcesOk: sessions.length,
    sourcesTotal: 3,
    level1,
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

/** Undefined under `next dev` (Node has no `caches`), so every use is
 *  guarded and the dev server simply runs uncached. */
function edgeCache(): EdgeCache | null {
  const c = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default
  return c ?? null
}

function cacheKey(request: Request): Request | null {
  try {
    return new Request(new URL("/api/cyph-flow", request.url).toString(), {
      method: "GET",
    })
  } catch {
    return null
  }
}

let lastSnapshot: CyphFlowResponse | null = null
let inFlight: Promise<CyphFlowResponse | null> | null = null

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

  const kv = await getKV()
  let mirror: CyphFlowResponse | null = null
  if (kv) {
    try {
      const raw = await kv.get(KV_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as CyphFlowResponse
        if (Number.isFinite(parsed.fetchedAt)) mirror = parsed
      }
    } catch {
      /* unreadable mirror — fall through and build */
    }
  }
  if (mirror && now - mirror.fetchedAt < KV_WARM_TTL_MS) {
    lastSnapshot = mirror
    return NextResponse.json(mirror, { headers: RESPONSE_HEADERS })
  }

  // Join a build already in progress rather than starting a second one.
  if (!inFlight) {
    inFlight = build(now).finally(() => {
      inFlight = null
    })
  }
  let fresh: CyphFlowResponse | null = null
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
        await kv.put(KV_KEY, body, { expirationTtl: KV_TTL_SECONDS })
      } catch {
        /* mirror write is best-effort */
      }
    }
    return new Response(body, { headers: RESPONSE_HEADERS })
  }

  // Upstream is down. Serve the mirror flagged stale, with its real age
  // intact so the UI can say how old it is instead of implying it is live.
  if (mirror) {
    return NextResponse.json(
      { ...mirror, stale: true },
      { headers: RESPONSE_HEADERS }
    )
  }
  return NextResponse.json(
    { error: "CYPH flow unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  )
}
