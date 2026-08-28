import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { marketSessionState } from "@/lib/market-session"
import type { CyphLiveBook, CyphLiveBookResponse } from "@/components/api-types"

export const dynamic = "force-dynamic"

/** Our authenticated bridge, the same host that fronts Binance for ZEC depth.
 *  It now also fronts Webull's Nasdaq TotalView book for CYPH, which is the
 *  only live depth we have: Databento's historical API is licensed only
 *  through the previous ET day for XNAS, so it cannot serve the current
 *  session at any delay. */
const BRIDGE = "https://depth.cyphzec.com"
/** Reuses the bridge token already bound for the ZEC path. The name is about
 *  the Binance route it was created for, not the host, and the host is the
 *  same — a second secret for one credential would be one more thing to
 *  rotate in two places. */
const TOKEN_ENV = "BINANCE_DEPTH_TOKEN"

const LEVELS = 20
const SOURCE_TIMEOUT_MS = 6_000
/** Live data. Held only long enough to collapse a burst of readers onto one
 *  upstream call — a book is worthless a minute late during a session. */
const FRESH_TTL_MS = 5_000
const EDGE_TTL_SECONDS = 5
/** A snapshot served because the session is over changes only when the next
 *  one ends, so it is held for minutes rather than seconds — that is the
 *  whole weekend spared a KV read per poll per reader.
 *
 *  A snapshot served because the bridge failed mid-session is the opposite
 *  case and deliberately does NOT get this: see `snapshotTtl`. */
const SNAPSHOT_FRESH_TTL_MS = 60_000
const EDGE_TTL_SNAPSHOT_SECONDS = 60

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

async function bridge(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${BRIDGE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`bridge ${path}: ${res.status}`)
  return res.json()
}

/** The bridge passes the upstream quote through under `raw`, which carries
 *  fields the normalised envelope omits — the true previous close among them. */
function raw(q: Record<string, unknown>): Record<string, unknown> | null {
  const r = q.raw
  return r && typeof r === "object" ? (r as Record<string, unknown>) : null
}

function num(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

/** `[price, size]` string pairs, as the bridge normalises both venues. */
function levels(raw: unknown): { px: number; sz: number }[] {
  if (!Array.isArray(raw)) return []
  const out: { px: number; sz: number }[] = []
  for (const row of raw) {
    if (!Array.isArray(row)) continue
    const px = num(row[0])
    const sz = num(row[1])
    if (px == null || px <= 0 || sz == null || sz < 0) continue
    out.push({ px, sz })
  }
  return out
}

/** The bridge's own phase label, mapped onto the calendar's vocabulary so the
 *  rest of the app has one set of session names. `closed` is deliberately not
 *  mapped to OVERNIGHT: CYPH carries `overnightTradeFlag: 0`, so nothing is
 *  matching overnight, and what the endpoint serves then is the resting
 *  post-market book — a snapshot, which `live` reports as false. */
const SESSION_BY_PHASE: Record<string, "PRE" | "REGULAR" | "AFTER" | null> = {
  pre_market: "PRE",
  regular: "REGULAR",
  after_hours: "AFTER",
  closed: null,
}

function buildBook(depth: unknown, quote: unknown): CyphLiveBook | null {
  const d = depth as Record<string, unknown> | null
  if (!d) return null
  const bids = levels(d.bids)
  const asks = levels(d.asks)
  if (bids.length === 0 && asks.length === 0) return null

  const phase = typeof d.marketSession === "string" ? d.marketSession : null
  const session = phase ? (SESSION_BY_PHASE[phase] ?? null) : null

  const rows = Math.max(bids.length, asks.length)
  const merged = Array.from({ length: rows }, (_, i) => ({
    bidPx: bids[i]?.px ?? null,
    bidSz: bids[i]?.sz ?? 0,
    bidCt: 0, // The bridge does not carry per-level order counts.
    askPx: asks[i]?.px ?? null,
    askSz: asks[i]?.sz ?? 0,
    askCt: 0,
  }))

  const bestBid = bids[0]?.px ?? null
  const bestAsk = asks[0]?.px ?? null
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null
  const bidShares = bids.reduce((a, l) => a + l.sz, 0)
  const askShares = asks.reduce((a, l) => a + l.sz, 0)
  const total = bidShares + askShares

  const q = quote as Record<string, unknown> | null

  return {
    venue: "XNAS",
    session,
    phase,
    phaseDesc:
      typeof d.marketSessionDesc === "string" ? d.marketSessionDesc : null,
    // A book is live only while a session is actually matching. Outside one the
    // endpoint serves the last resting post-market book, which must not be
    // presented as the current market.
    live: session != null,
    at: Date.now(),
    levels: merged,
    bestBid,
    bestAsk,
    mid,
    spread,
    spreadBps: spread != null && mid ? (spread / mid) * 10_000 : null,
    bidShares,
    askShares,
    bidNotional: bids.reduce((a, l) => a + l.sz * l.px, 0),
    askNotional: asks.reduce((a, l) => a + l.sz * l.px, 0),
    imbalancePct: total > 0 ? ((bidShares - askShares) / total) * 100 : null,
    last: q ? num(q.latestPrice) : null,
    // NOT `regularClose`. During regular hours the bridge reports that field as
    // the CURRENT close, equal to `latestPrice` — verified live at 1.750/1.750
    // while the day's actual previous close was 1.420. `raw.preClose` is the
    // previous close in every phase, and there is deliberately no fallback to
    // `regularClose`: falling back to the field this exists to avoid would
    // render a plausible, wrong +0.0% for a whole session. Null instead, and
    // the panel omits the change rather than inventing one.
    previousClose: q ? num(raw(q)?.preClose) : null,
    open: q ? num(raw(q)?.open) : null,
    high: q ? num(raw(q)?.high) : null,
    low: q ? num(raw(q)?.low) : null,
    // Null during regular hours, where there is no extended session to change
    // against. Reported as given rather than substituted.
    extendedChangePct: q ? num(q.extendedChangeRatio) : null,
    volume: q ? num(q.volume) : null,
    tradeTime: q && typeof q.tradeTime === "string" ? q.tradeTime : null,
  }
}

// ---------------------------------------------------------------------------
// The last live book, kept for the hours when there is no live book at all
// ---------------------------------------------------------------------------
// Between 20:00 and 04:00 ET the bridge answers `marketSession: "closed"`
// with empty sides, and across a weekend it does so for sixty hours. The
// other fallback, the delayed Databento session book, is embargoed a full day
// for Nasdaq — so at 20:01 the freshest book it can offer is the PREVIOUS
// day's close, roughly 28 hours old, when the market itself finished sixty
// seconds ago and we were rendering that book at the time.
//
// So the last genuinely live book is persisted and served in that gap,
// labelled with when it was taken. It is never presented as current: `book`
// stays null and this arrives under its own field.
const SNAPSHOT_KEY = "cyph.lastbook.v1"
/** Four days, which is two independent bounds meeting in the middle.
 *
 *  The floor: the longest gap this has to cover is a Friday close to a
 *  Tuesday open across a Monday holiday, about 3 days 8 hours. Anything less
 *  and the feature goes dark on exactly the weekends it exists for.
 *
 *  The ceiling: the UI labels this book by weekday and time — "book is Thu
 *  7:52 PM ET" — which stops being unambiguous at seven days, the moment the
 *  weekday name comes round again. A value may not outlive the precision of
 *  the label it will be shown under, so it expires well before then. */
const SNAPSHOT_TTL_SECONDS = 4 * 24 * 60 * 60
/** Writes are the scarce resource here — this route is polled every 15s per
 *  reader — so a book is persisted at most this often per isolate. The cost
 *  is that the stored snapshot can be up to this old when a session ends,
 *  which for a book being shown as explicitly-not-live is a fair trade
 *  against thousands of daily writes. */
const SNAPSHOT_WRITE_INTERVAL_MS = 15 * 60_000

interface KVLike {
  get: (key: string) => Promise<string | null>
  put: (
    key: string,
    value: string,
    options?: { expirationTtl?: number }
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

let lastPersistAt = 0

/** The write to make for this book, or null when there is nothing to do.
 *
 *  Only a live book is ever stored, and that is the whole point: outside a
 *  session the bridge serves the last resting post-market book, so storing
 *  those would let one stale book refresh its own timestamp every poll all
 *  night — the snapshot would end up claiming 03:00 for a market that closed
 *  at 20:00, which is precisely the lie this exists to avoid. */
function snapshotWrite(book: CyphLiveBook): Promise<void> | null {
  if (!book.live) return null
  const now = Date.now()
  const previous = lastPersistAt
  if (now - previous < SNAPSHOT_WRITE_INTERVAL_MS) return null
  // Claimed before the write so concurrent requests in this isolate do not
  // all attempt one, and rolled back if the write does not happen. Advancing
  // it regardless would let a single transient KV failure suppress the next
  // fifteen minutes of attempts — and a failure in the last quarter hour of
  // a session would leave no snapshot from that session at all, sending the
  // whole night back to the day-old book this exists to replace.
  lastPersistAt = now
  return (async () => {
    const kv = await getKV()
    if (!kv) {
      lastPersistAt = previous
      return
    }
    try {
      await kv.put(SNAPSHOT_KEY, JSON.stringify(book), {
        expirationTtl: SNAPSHOT_TTL_SECONDS,
      })
    } catch {
      // A missed snapshot costs the overnight fallback, not the live book —
      // so it is not worth failing the request over, but it IS worth
      // retrying on the next poll rather than in fifteen minutes.
      lastPersistAt = previous
    }
  })()
}

/** Run work that must outlive the response.
 *
 *  A floating promise is not a background task on Workers — the isolate can
 *  be torn down the moment the response is returned, so `void doWrite()`
 *  would drop the snapshot an unknowable fraction of the time, and the
 *  failure would only ever show up as an empty overnight fallback hours
 *  later. `waitUntil` is the contract for this; without one, pay for the
 *  write inline. It is throttled to once per SNAPSHOT_WRITE_INTERVAL_MS, so
 *  at most one reader per window ever waits on a KV put. */
async function afterResponse(work: Promise<void>): Promise<void> {
  try {
    const ctx = await getCloudflareContext({ async: true })
    const exec = (ctx as { ctx?: { waitUntil?: (p: Promise<unknown>) => void } })
      ?.ctx
    if (typeof exec?.waitUntil === "function") {
      exec.waitUntil(work)
      return
    }
  } catch {
    /* no execution context — fall through and await */
  }
  await work.catch(() => {})
}

async function readSnapshot(): Promise<CyphLiveBook | null> {
  const kv = await getKV()
  if (!kv) return null
  try {
    const raw = await kv.get(SNAPSHOT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CyphLiveBook
    // Defensive: only a live-when-taken book with a real timestamp is worth
    // showing, and `live` here describes the moment it was stored.
    if (!parsed?.live || !Number.isFinite(parsed.at)) return null
    return parsed
  } catch {
    return null
  }
}

/** How long a null-book response may be held, which turns entirely on WHY it
 *  is null.
 *
 *  Outside a covered session there is no live book coming until the next one
 *  opens, so the long hold is free. Inside one, a null book means the bridge
 *  just failed — a timeout, a bad gateway — and it may well answer the very
 *  next call; holding that for a minute would suppress a live book long after
 *  the market came back. Same body, opposite meaning, so the calendar decides
 *  rather than the shape of the payload.
 *
 *  An unresolved calendar takes the short hold: guessing wrong that way costs
 *  a few KV reads, guessing wrong the other way costs a minute of blindness
 *  during a live session. */
function snapshotTtl(): { memoMs: number; edgeSeconds: number } {
  const state = marketSessionState()
  const current = state?.current?.session ?? null
  const covered =
    current === "PRE" || current === "REGULAR" || current === "AFTER"
  if (!state || covered) {
    return { memoMs: FRESH_TTL_MS, edgeSeconds: EDGE_TTL_SECONDS }
  }

  // ...and never past the next boundary. This is decided when the origin
  // runs; the edge then hands out that copy without consulting a calendar, so
  // a full minute granted at 03:59:59 would still be answering "no live book"
  // a minute into pre-market, with the bridge live the whole time. Clamped
  // here, the cached copy expires exactly when the answer can change.
  const untilBoundary = Math.min(
    state.msToClose ?? Number.POSITIVE_INFINITY,
    state.msToOpen ?? Number.POSITIVE_INFINITY
  )
  return {
    // Exact milliseconds. Rounding a deadline outward is the one direction
    // that cannot be right: at 03:59:59.9 a rounded-up second would put the
    // expiry at 04:00:00.9, back inside the session it exists to stop at.
    memoMs: Math.min(SNAPSHOT_FRESH_TTL_MS, untilBoundary),
    // Shared caches only understand whole seconds, so round DOWN and let a
    // final sub-second sliver be uncacheable rather than overshoot.
    edgeSeconds: Math.min(
      EDGE_TTL_SNAPSHOT_SECONDS,
      Math.floor(untilBoundary / 1_000)
    ),
  }
}

/** Cache-Control for a body that may be held `edgeSeconds`. Zero is not a
 *  degenerate case here: it is the last sliver before a session boundary,
 *  where the only honest instruction is not to share the copy at all. */
function cacheHeader(edgeSeconds: number): string {
  return edgeSeconds > 0
    ? `public, max-age=0, s-maxage=${edgeSeconds}`
    : "no-store"
}

/** The memo carries its own expiry rather than a TTL recomputed on read.
 *
 *  Recomputing was wrong in a way the clamp did not reach: a null body stored
 *  at 03:59:58 under the closed-session rule was re-served at 04:00:00,
 *  because by then the calendar said "covered" and that branch allows five
 *  seconds — so the origin repopulated the edge with the stale negative the
 *  moment the clamped edge copy expired. The decision has to travel with the
 *  value it was made about. */
let memo: {
  expiresAt: number
  edgeSeconds: number
  body: CyphLiveBookResponse
} | null = null
let inFlight: Promise<CyphLiveBookResponse | null> | null = null

async function build(token: string): Promise<CyphLiveBookResponse | null> {
  // The quote is a bonus; a book without it is still the point of this route.
  const [depth, quote] = await Promise.allSettled([
    bridge(token, `/stock/api/v3/depth?symbol=CYPH&limit=${LEVELS}`),
    bridge(token, "/stock/api/v3/quote?symbol=CYPH"),
  ])
  if (depth.status !== "fulfilled") return null
  const book = buildBook(
    depth.value,
    quote.status === "fulfilled" ? quote.value : null
  )
  if (!book) return null
  return { fetchedAt: Date.now(), book }
}

export async function GET() {
  const now = Date.now()
  if (memo && now < memo.expiresAt) {
    // The edge copy may not outlive the memo either, or a boundary-clamped
    // hold would be walked past one hit at a time — each hit handing out the
    // full original TTL from a later starting point.
    const remaining = Math.floor((memo.expiresAt - now) / 1_000)
    return NextResponse.json(memo.body, {
      headers: {
        "Cache-Control": cacheHeader(Math.min(memo.edgeSeconds, remaining)),
      },
    })
  }

  const token = await getSecret(TOKEN_ENV)
  if (!token) {
    return NextResponse.json(
      { error: `CYPH live book needs the ${TOKEN_ENV} binding`, needsKey: true },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }

  if (!inFlight) {
    inFlight = build(token).finally(() => {
      inFlight = null
    })
  }
  let fresh: CyphLiveBookResponse | null = null
  try {
    fresh = await inFlight
  } catch {
    fresh = null
  }

  // A book counts as the live book only when it IS live. The bridge also
  // serves a resting post-market book outside a session — levels and all,
  // `live: false`, as SESSION_BY_PHASE documents — and returning that from
  // here would skip the snapshot lookup below entirely: the client rejects a
  // non-live book, `lastLive` would never be sent, and every surface would
  // drop to the day-old Databento book. That is the exact gap this feature
  // exists to close, so a non-live book takes the same road as no book.
  const liveBook = fresh?.book?.live ? fresh.book : null

  if (fresh && liveBook) {
    memo = {
      expiresAt: Date.now() + FRESH_TTL_MS,
      edgeSeconds: EDGE_TTL_SECONDS,
      body: fresh,
    }
    const write = snapshotWrite(liveBook)
    if (write) await afterResponse(write)
    return NextResponse.json(fresh, {
      headers: {
        "Cache-Control": `public, max-age=0, s-maxage=${EDGE_TTL_SECONDS}`,
      },
    })
  }

  // No live book. Never serve one anyway — the caller must be able to tell
  // the current market from a record of it — but the last live book, under
  // its own field and with its own timestamp, is a truthful and far more
  // useful answer here than the day-old session book that would otherwise
  // fill the gap.
  const lastLive = await readSnapshot()
  if (lastLive) {
    const body: CyphLiveBookResponse = {
      fetchedAt: Date.now(),
      book: null,
      lastLive,
    }
    const ttl = snapshotTtl()
    memo = {
      expiresAt: Date.now() + ttl.memoMs,
      edgeSeconds: ttl.edgeSeconds,
      body,
    }
    return NextResponse.json(body, {
      headers: { "Cache-Control": cacheHeader(ttl.edgeSeconds) },
    })
  }

  // Nothing live and nothing stored. The caller falls back to the delayed
  // Databento session book, which is at least honestly labelled.
  return NextResponse.json(
    { error: "CYPH live book unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  )
}
