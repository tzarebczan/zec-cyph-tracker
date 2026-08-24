import { NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
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
    regularClose: q ? num(q.regularClose) : null,
    extendedChangePct: q ? num(q.extendedChangeRatio) : null,
    volume: q ? num(q.volume) : null,
    tradeTime: q && typeof q.tradeTime === "string" ? q.tradeTime : null,
  }
}

let memo: { at: number; body: CyphLiveBookResponse } | null = null
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
  if (memo && now - memo.at < FRESH_TTL_MS) {
    return NextResponse.json(memo.body, {
      headers: {
        "Cache-Control": `public, max-age=0, s-maxage=${EDGE_TTL_SECONDS}`,
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

  if (fresh) {
    memo = { at: Date.now(), body: fresh }
    return NextResponse.json(fresh, {
      headers: {
        "Cache-Control": `public, max-age=0, s-maxage=${EDGE_TTL_SECONDS}`,
      },
    })
  }

  // Serving a stale live book would be worse than saying nothing: the caller
  // falls back to the delayed Databento session book, which is at least
  // honestly labelled.
  return NextResponse.json(
    { error: "CYPH live book unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  )
}
