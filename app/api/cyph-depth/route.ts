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
/** Shorter hold for a build that is missing a session because a request
 *  failed, so the gap is retried soon rather than at the next publish. */
const EDGE_TTL_INCOMPLETE_SECONDS = 30
/** A published session never changes, so the mirror can live a long time.
 *  Keyed by session date, so a new day is a new key rather than an
 *  overwrite. */
const KV_TTL_SECONDS = 7 * 24 * 60 * 60
const KV_PREFIX = "cyph.depth.v1"

/** Cache policy for a payload, keyed on whether it describes the day
 *  completely. An incomplete build is meant to live 30s so the missing
 *  session is retried promptly — which only holds if EVERY path that returns
 *  it says so. Handing an incomplete payload the static 5-minute policy let a
 *  shared cache keep it for ten times its intended life. */
function responseHeaders(complete: boolean) {
  return {
    "Content-Type": "application/json",
    "Cache-Control": `public, max-age=0, s-maxage=${
      complete ? EDGE_TTL_SECONDS : EDGE_TTL_INCOMPLETE_SECONDS
    }`,
  }
}

const DATABENTO_KEY_ENV = "DATA_BENTO_API"

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

/** Keyed by dataset: the two venues publish on their own schedules and a
 *  single shared slot would evict one on every call for the other. */
const publishedThroughCache = new Map<string, { end: number | null; at: number }>()

/** Latest instant Databento has published for a dataset. Past this line the
 *  API refuses the request as needing a live licence, so it is a hard read
 *  boundary and not merely a hint. Memoised per instance — see
 *  PUBLISHED_THROUGH_TTL_MS. */
async function datasetEnd(key: string, dataset: string): Promise<number | null> {
  const now = Date.now()
  const hit = publishedThroughCache.get(dataset)
  if (hit && now - hit.at < PUBLISHED_THROUGH_TTL_MS) return hit.end
  const raw = await databento(key, "metadata.get_dataset_range", { dataset })
  const parsed = JSON.parse(raw) as { end?: string }
  const ms = typeof parsed.end === "string" ? Date.parse(parsed.end) : NaN
  const end = Number.isFinite(ms) ? ms : null
  publishedThroughCache.set(dataset, { end, at: now })
  return end
}

/** Whether `stored` is still the boundary a fresh build would record, or
 *  `undefined` when that cannot be determined — in which case a caller should
 *  keep the mirror rather than read "cannot tell" as "changed".
 *
 *  `build` treats an unusable Blue Ocean boundary as "no OCEA sessions" and
 *  carries on, because there a Nasdaq-only payload beats none at all. Here
 *  the alternative is a complete cached day, and OCEA normally runs ahead, so
 *  the same tolerance would drop the computed boundary below a full mirror's,
 *  discard it, and rebuild into the same outage.
 *
 *  But "unusable OCEA means inconclusive" cannot be the whole rule either: a
 *  boundary that stays unusable would then never invalidate anything, and the
 *  mirror would be pinned for good — which is worse than what it guards
 *  against, and silent. So OCEA only clouds the answer when it could have
 *  been what set `stored` in the first place. Once Nasdaq's own line advances
 *  past that value, the comparison is decidable without OCEA at all, and the
 *  mirror is released within the day however long the outage lasts. */
async function mirrorIsCurrent(
  key: string,
  stored: number
): Promise<boolean | undefined> {
  const [xnas, ocea] = await Promise.all([
    datasetEnd(key, XNAS).catch(() => undefined),
    datasetEnd(key, OCEA).catch(() => undefined),
  ])
  // Nasdaq is the required half — `build` itself gives up without it.
  if (xnas == null) return undefined
  // A throw, or a range whose `end` was missing or unparseable: `datasetEnd`
  // reports both as an absent boundary, and neither is an answer.
  if (ocea == null) return stored > xnas ? undefined : stored === xnas
  return stored === Math.max(xnas, ocea)
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

/** Outcome of asking for one session's closing book.
 *
 *  `empty` and `failed` must stay distinct even though both yield no book.
 *  A session that genuinely never had a resting book is a permanent fact
 *  about that day and is safe to cache forever; a session whose every request
 *  errored is a transient miss that has to be retried. Collapsing the two
 *  let a timeout be written into the immutable per-date key, which then
 *  served an incomplete book for the rest of the publication interval. */
type BookResult =
  | { status: "book"; book: CyphDepthBook }
  | { status: "empty" }
  | { status: "failed" }

async function closingBook(
  key: string,
  session: MarketSession,
  dataset: string,
  venue: "XNAS" | "OCEA",
  start: number,
  end: number
): Promise<BookResult> {
  let attempted = 0
  // Whether a query spanning the WHOLE session came back. Only that proves an
  // absent book, and it is not the same as "some query came back": a five
  // minute window answering empty says the last five minutes were quiet, not
  // that the session was.
  let readWholeSession = false
  for (const back of CLOSING_WINDOWS_MS) {
    const from = back === Infinity ? start : Math.max(start, end - back)
    if (from >= end) continue
    attempted++
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
    // `from === start` means this query covered the session end to end. That
    // is the Infinity tier, and also any narrower tier on a session shorter
    // than its window, which `Math.max` clamps to `start`.
    if (from === start) readWholeSession = true
    const rec = lastRecord(body)
    if (!rec) continue
    const book = normalise(session, venue, rec, from, end)
    if (book) return { status: "book", book }
  }
  // A zero-length window is empty by construction — there is no interval in
  // which a book could have rested — so it is not a failure to retry.
  if (attempted === 0) return { status: "empty" }
  // Otherwise emptiness is only established by a successful whole-session
  // read. Anything less (a narrow window answering empty while the wider ones
  // errored) leaves us not knowing, which is a transient miss, not a fact
  // about the day, and must not be pinned.
  return readWholeSession ? { status: "empty" } : { status: "failed" }
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

/** How far back to look for a day with published sessions. Covers a long
 *  holiday weekend, which is the widest real gap between trading days. */
const TARGET_LOOKBACK_DAYS = 6

async function build(key: string): Promise<CyphDepthResponse | null> {
  // Each venue publishes on its own clock, and the gap between them is large:
  // Blue Ocean has been observed within ~35 minutes of real time while Nasdaq
  // sat 8 hours back. So the boundary must be read per dataset — one shared
  // number would either withhold a published overnight book or ask Nasdaq for
  // a session it refuses with `license_not_found_unauthorized`.
  const [endXnas, endOcea] = await Promise.all([
    datasetEnd(key, XNAS),
    datasetEnd(key, OCEA).catch(() => null),
  ])
  if (endXnas == null) return null
  const boundary = (dataset: string) => (dataset === OCEA ? endOcea : endXnas)
  const published = Math.max(endXnas, endOcea ?? 0)

  // Walk back from the day the newest boundary falls in until a day has at
  // least one session that is FULLY published. Deriving the date from the
  // boundary alone was the bug this replaces: once Nasdaq's boundary advanced
  // to Monday 00:00 ET, stepping back an hour landed on Sunday, and Sunday
  // closes no sessions at all — so the plan came out empty and the route
  // 503'd with a working key and a healthy upstream.
  let target: { year: number; month: number; day: number } | null = null
  let plan: ReturnType<typeof sessionPlan> = []
  let pending = 0
  for (let back = 0; back <= TARGET_LOOKBACK_DAYS; back++) {
    const at = etNow(new Date(published - back * 24 * 60 * 60_000))
    if (!at) continue
    const all = sessionPlan(at)
    // A session whose close is past its venue's boundary has not published
    // yet. That is pending, not missing: skip the request rather than spend a
    // credit on a certain 403, and remember that the day is still filling in.
    const ready = all.filter((p) => {
      const b = boundary(p.dataset)
      return b != null && p.end <= b
    })
    if (ready.length > 0) {
      target = { year: at.year, month: at.month, day: at.day }
      plan = ready
      pending = all.length - ready.length
      break
    }
  }
  if (!target) return null
  const inside = target

  const results = await Promise.all(
    plan.map((p) =>
      closingBook(key, p.session, p.dataset, p.venue, p.start, p.end).catch(
        (): BookResult => ({ status: "failed" })
      )
    )
  )
  const sessions = results.flatMap((r) => (r.status === "book" ? [r.book] : []))
  if (sessions.length === 0) return null

  return {
    fetchedAt: Date.now(),
    sessionDate: `${inside.year}-${String(inside.month).padStart(2, "0")}-${String(inside.day).padStart(2, "0")}`,
    publishedThrough: published,
    sessions,
    sessionsOk: sessions.length,
    sessionsTotal: plan.length + pending,
    pending,
    // Every planned session either produced a book or was PROVEN empty by a
    // whole-session read, AND no session of the day is still waiting to
    // publish. Only such a payload describes the day completely, and only
    // such a payload may be pinned in the per-date cache — see the KV write
    // below. A day still filling in must stay unpinned or the sessions that
    // publish later would never be picked up.
    complete: pending === 0 && results.every((r) => r.status !== "failed"),
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

  const memTtl = lastSnapshot?.complete === false
    ? EDGE_TTL_INCOMPLETE_SECONDS * 1_000
    : FRESH_TTL_MS
  if (lastSnapshot && now - lastSnapshot.fetchedAt < memTtl) {
    return NextResponse.json(lastSnapshot, {
      headers: responseHeaders(lastSnapshot.complete),
    })
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
          headers: {
            "Content-Type": "application/json",
            // The stored copy's own policy already encodes whether that
            // payload was complete, so forward it instead of stamping the
            // static one over the top. Absent a stored header, assume the
            // shorter life: holding a possibly-incomplete book too briefly
            // costs a rebuild, holding it too long hides a missing session.
            "Cache-Control":
              hit.headers.get("Cache-Control") ??
              `public, max-age=0, s-maxage=${EDGE_TTL_INCOMPLETE_SECONDS}`,
          },
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
          // one, and only if it describes its day completely. `complete` is
          // checked defensively — an incomplete payload is never written — so
          // a mirror from an older build can't pin a partial book.
          if (
            Number.isFinite(parsed.fetchedAt) &&
            parsed.sessions?.length &&
            // `=== true`, not `!== false`: a snapshot written before this
            // field existed carries no completeness at all, and an unknown
            // is a reason to rebuild rather than to trust. Costs one rebuild
            // per legacy entry, after which it is re-pinned with the flag.
            parsed.complete === true
          ) {
            // Three distinct cases, which an `apiKey == null ||` shortcut
            // used to collapse into "current":
            //   • no key at all — a misconfiguration. We cannot tell whether
            //     this mirror is current, and silently serving a week-old
            //     book would hide the broken binding, so fall through to the
            //     503 below that names it.
            //   • the check itself failed — transient. The mirror is the best
            //     we have and it states its own session date, so serve it.
            //   • an answer — authoritative. Serve only on a match.
            //
            // Both datasets, because `publishedThrough` is the max of both.
            // Asking Nasdaq alone reintroduces the single shared boundary
            // `build` is careful to avoid, and it fails in exactly the way
            // that comment warns of: Blue Ocean runs hours ahead, so when it
            // advanced 8h past a frozen Nasdaq line the stored max still
            // equalled Nasdaq's end, the mirror was judged current, and a
            // published overnight book went unserved for 17 hours while the
            // tile showed the previous day's after-hours close.
            const verdict =
              apiKey == null
                ? undefined
                : await mirrorIsCurrent(apiKey, parsed.publishedThrough)
            const stillCurrent = apiKey != null && verdict !== false
            if (stillCurrent) {
              lastSnapshot = parsed
              return NextResponse.json(parsed, {
                headers: responseHeaders(parsed.complete),
              })
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
    // An incomplete build is served — it is the best available — but it is
    // held for seconds rather than minutes so the missing session is retried
    // promptly instead of riding out the whole publication interval.
    const edgeTtl = fresh.complete ? EDGE_TTL_SECONDS : EDGE_TTL_INCOMPLETE_SECONDS
    if (cache && key) {
      try {
        await cache.put(
          key,
          new Response(body, {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": `public, max-age=0, s-maxage=${edgeTtl}`,
            },
          })
        )
      } catch {
        /* a cache write failure must not fail the request */
      }
    }
    // Only a complete day goes in the per-date key. That key is treated as
    // immutable, and pinning a payload that is missing a session because a
    // request timed out would freeze the gap in for the rest of the day.
    if (kv && fresh.complete) {
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
    return new Response(body, { headers: responseHeaders(fresh.complete) })
  }

  return NextResponse.json(
    { error: "CYPH depth unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  )
}
